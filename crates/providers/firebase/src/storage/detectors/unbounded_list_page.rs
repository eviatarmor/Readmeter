use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.storage/unbounded-list-page";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let _ = p;
    Ok(Box::new(UnboundedListPage))
}

/// `list()` with no caller `maxResults`. The server still caps the page,
/// but the caller did not choose the bound.
struct UnboundedListPage;

impl Detector for UnboundedListPage {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "list") || !billed(env) {
            return;
        }
        let limited = env.query.as_ref().is_some_and(|q| q.limit.is_some());
        if limited {
            return;
        }
        let items = env.items();
        out.emit(
            env,
            format!(
                "`{}` list() has no maxResults; pass maxResults and follow the page token",
                env.target.template
            ),
        )
        .evidence("items", items);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[])
    }

    fn list(limit: Option<u32>, items: u64) -> readmeter_core::Envelope {
        let mut b = EnvBuilder::new(Op::Other("list".into()), "photos")
            .provider("firebase", "storage")
            .items(items);
        if let Some(limit) = limit {
            b = b.with_query(|q| q.limit = Some(limit));
        }
        b.build()
    }

    #[test]
    fn flags_a_list_that_did_not_set_max_results() {
        let mut e = engine();
        let f = run(&mut e, [list(None, 0)]);
        assert_eq!(f.len(), 1);
        assert!(run(&mut engine(), [list(Some(100), 100)]).is_empty());
    }

    #[test]
    fn list_all_and_errors_are_quiet() {
        let mut e = engine();
        let all = EnvBuilder::new(Op::Other("list_all".into()), "photos")
            .provider("firebase", "storage")
            .items(0);
        let failed = EnvBuilder::new(Op::Other("list".into()), "photos")
            .provider("firebase", "storage")
            .error("network");
        assert!(run(&mut e, [all.build(), failed.build()]).is_empty());
    }
}
