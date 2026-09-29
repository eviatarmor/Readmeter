use std::collections::HashMap;

use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/read-modify-write-counter";

/// Hard cap on open transactions; state resets beyond it.
const MAX_TRACKED: usize = 16_384;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ReadModifyWriteCounter {
        min_transactions: p.u64("min_transactions")?.max(1) as usize,
        gets: HashMap::new(),
        window: KeyedWindow::new(window_ms),
    }))
}

/// A transaction that reads one document and writes it back, used as a counter.
struct ReadModifyWriteCounter {
    min_transactions: usize,
    /// (session, transaction) -> document keys read, capped at 2
    gets: HashMap<(u64, u64), Vec<u64>>,
    /// (session, document key) -> attempt of each counter commit
    window: KeyedWindow<(u64, u64), u32>,
}

impl Detector for ReadModifyWriteCounter {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        match env.op {
            Op::Get => {
                let Some(tx) = env.ctx.transaction else {
                    return;
                };
                let key = (env.ctx.session, tx);
                if let Some(gets) = self.gets.get_mut(&key) {
                    if gets.len() < 2 {
                        gets.push(env.target.key);
                    }
                    return;
                }
                if self.gets.len() >= MAX_TRACKED {
                    self.gets.clear();
                }
                self.gets.insert(key, vec![env.target.key]);
            }
            Op::Commit {
                writes,
                deletes,
                transactional: true,
            } => {
                let Some(tx) = env.ctx.transaction else {
                    return;
                };
                let Some(gets) = self.gets.remove(&(env.ctx.session, tx)) else {
                    return;
                };
                let Ok([doc]) = <[u64; 1]>::try_from(gets) else {
                    return;
                };
                if writes != 1 || deletes != 0 || doc != env.target.key {
                    return;
                }
                let group = (env.ctx.session, doc);
                let samples = self.window.push(group, env.ts_ms, env.ctx.attempt);
                if samples.len() < self.min_transactions {
                    return;
                }
                let transactions = samples.len();
                let mut attempts = 0u64;
                for (_, attempt) in samples.iter() {
                    attempts = attempts.saturating_add(u64::from(*attempt));
                }
                self.window.remove(&group);
                out.emit(
                    env,
                    format!(
                        "`{}` was incremented with a read-then-write transaction {transactions} times; increment() does it without a read or contention",
                        env.target.template
                    ),
                )
                .evidence("transactions", transactions)
                .evidence("attempts", attempts)
                .wasted(READS, transactions as u64);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Scalar;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(600_000)), ("min_transactions", int(3))],
        )
    }

    fn get(tx: u64, key: u64, session: u64) -> Envelope {
        EnvBuilder::get("accounts/{id}")
            .key(key)
            .items(1)
            .transaction(tx)
            .session(session)
            .build()
    }

    fn commit(tx: u64, key: u64, session: u64, attempt: u32, transactional: bool) -> Envelope {
        EnvBuilder::new(
            Op::Commit {
                writes: 1,
                deletes: 0,
                transactional,
            },
            "accounts/{id}",
        )
        .key(key)
        .transaction(tx)
        .session(session)
        .attempt(attempt)
        .build()
    }

    #[test]
    fn three_counter_transactions_waste_their_reads() {
        let mut e = engine();
        let mut envs = Vec::new();
        for (i, attempt) in [1u32, 2, 4].into_iter().enumerate() {
            let tx = i as u64 + 1;
            envs.push(get(tx, 9, 1));
            envs.push(commit(tx, 9, 1, attempt, true));
        }
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "`accounts/{id}` was incremented with a read-then-write transaction 3 times; increment() does it without a read or contention"
        );
        assert_eq!(f[0].evidence.get("transactions"), Some(&Scalar::U64(3)));
        assert_eq!(f[0].evidence.get("attempts"), Some(&Scalar::U64(7)));
        assert_eq!(f[0].wasted.get(READS), 3);
    }

    #[test]
    fn two_gets_do_not_count() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                get(1, 9, 1),
                get(1, 9, 1),
                commit(1, 9, 1, 1, true),
                get(2, 9, 1),
                commit(2, 9, 1, 1, true),
                get(3, 9, 1),
                commit(3, 9, 1, 1, true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn commit_to_another_document_does_not_count() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                get(1, 9, 1),
                commit(1, 8, 1, 1, true),
                get(2, 9, 1),
                commit(2, 9, 1, 1, true),
                get(3, 9, 1),
                commit(3, 9, 1, 1, true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn non_transactional_commit_does_not_count() {
        let mut e = engine();
        let f = run(&mut e, [get(1, 9, 1), commit(1, 9, 1, 1, false)]);
        assert!(f.is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        let mut envs = Vec::new();
        for session in [1u64, 2] {
            for tx in [1u64, 2] {
                envs.push(get(tx, 9, session));
                envs.push(commit(tx, 9, session, 1, true));
            }
        }
        assert!(run(&mut e, envs).is_empty());
    }
}
