use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.database/unindexed-query";

pub fn build(_: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(UnindexedQuery))
}

/// The web shim turns the SDK's "Using an unspecified index" console warning
/// into an `index_warning` envelope. The server answered that listen without
/// an index, so it sent the whole location for the client to filter.
struct UnindexedQuery;

impl Detector for UnindexedQuery {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.service != "database"
            || !matches!(&env.op, Op::Other(name) if name == "index_warning")
        {
            return;
        }
        // The shim always names the child; without it there is nothing to fix.
        let Some(child) = env.query.as_ref().and_then(|q| q.order_by.first()) else {
            return;
        };
        let child = child.field.as_str();
        out.emit(
            env,
            format!(
                "Query on `{template}` ordered by `{child}` has no .indexOn; the server sends the whole location and the client filters it",
                template = env.target.template
            ),
        )
        .evidence("order_by", child);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Envelope, Op};
    use readmeter_rules::testing::{EnvBuilder, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[])
    }

    fn warning(template: &str, child: &str) -> Envelope {
        EnvBuilder::new(Op::Other("index_warning".into()), template)
            .provider("firebase", "database")
            .with_query(|q| {
                q.order_by.push(readmeter_core::OrderShape {
                    field: child.into(),
                    descending: false,
                })
            })
            .build()
    }

    #[test]
    fn fires_on_index_warning() {
        let mut e = engine();
        let f = run(&mut e, [warning("rooms/{id}/scores", "pts")]);
        assert_eq!(f.len(), 1);
        assert!(
            f[0].message.contains("`rooms/{id}/scores`"),
            "{}",
            f[0].message
        );
        assert!(f[0].message.contains("`pts`"), "{}", f[0].message);
    }

    #[test]
    fn ordered_queries_and_other_services_are_quiet() {
        let mut e = engine();
        let ordered = EnvBuilder::query("rooms/{id}/scores")
            .provider("firebase", "database")
            .with_query(|q| {
                q.order_by.push(readmeter_core::OrderShape {
                    field: "pts".into(),
                    descending: false,
                })
            })
            .bytes(10_000_000)
            .build();
        let child = EnvBuilder::new(Op::Other("child_added".into()), "rooms/{id}/scores")
            .provider("firebase", "database")
            .build();
        let mut firestore = warning("scores", "pts");
        firestore.service = "firestore".into();
        let no_child = EnvBuilder::new(Op::Other("index_warning".into()), "scores")
            .provider("firebase", "database")
            .build();
        assert!(run(&mut e, [ordered, child, firestore, no_child]).is_empty());
    }
}
