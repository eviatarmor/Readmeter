use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/transaction-contention";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(TransactionContention {
        max_attempts: u32::try_from(p.u64("max_attempts")?)
            .unwrap_or(u32::MAX)
            .max(2),
    }))
}

/// Transactions retried because of contention. Every attempt re-reads (and
/// re-bills) the documents the transaction reads.
struct TransactionContention {
    max_attempts: u32,
}

impl Detector for TransactionContention {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Op::Commit {
            transactional: true,
            ..
        } = env.op
        else {
            return;
        };
        let attempt = env.ctx.attempt;
        if attempt < self.max_attempts {
            return;
        }
        out.emit(
            env,
            format!(
                "transaction on `{}` needed {attempt} attempts; reduce contention or move to increment()/batched writes",
                env.target.template
            ),
        )
        .evidence("attempt", attempt);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn commit(attempt: u32, transactional: bool) -> Envelope {
        EnvBuilder::new(
            Op::Commit {
                writes: 1,
                deletes: 0,
                transactional,
            },
            "accounts/{id}",
        )
        .attempt(attempt)
        .build()
    }

    #[test]
    fn flags_retried_transactions() {
        let mut e = single_rule_engine(ID, build, &[("max_attempts", int(3))]);
        assert_eq!(
            run(&mut e, [commit(3, true), commit(2, true), commit(5, false)]).len(),
            1
        );
    }
}
