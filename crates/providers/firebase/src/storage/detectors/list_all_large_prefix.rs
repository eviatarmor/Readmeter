use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.storage/list-all-large-prefix";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ListAllLargePrefix {
        min_items: p.u64("min_items")?.max(1),
    }))
}

/// `listAll` (or an auto-paginated server list) walked a large prefix.
struct ListAllLargePrefix {
    min_items: u64,
}

impl Detector for ListAllLargePrefix {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "list_all") || !billed(env) {
            return;
        }
        let items = env.items();
        if items < self.min_items {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` listAll returned {items} entries; page with list() and a maxResults",
                env.target.template
            ),
        )
        .evidence("items", items);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_items", int(1000))])
    }

    fn listed(op: &str, items: u64) -> readmeter_core::Envelope {
        EnvBuilder::new(Op::Other(op.into()), "photos")
            .provider("firebase", "storage")
            .items(items)
            .build()
    }

    #[test]
    fn flags_a_thousand_entry_list_all() {
        let mut e = engine();
        assert!(run(&mut e, [listed("list_all", 999)]).is_empty());
        let mut hot = engine();
        assert_eq!(run(&mut hot, [listed("list_all", 1000)]).len(), 1);
    }

    #[test]
    fn a_bounded_list_does_not_count() {
        let mut e = engine();
        assert!(run(&mut e, [listed("list", 1000)]).is_empty());
        let failed = EnvBuilder::new(Op::Other("list_all".into()), "photos")
            .provider("firebase", "storage")
            .items(1000)
            .error("network");
        assert!(run(&mut e, [failed.build()]).is_empty());
    }
}
