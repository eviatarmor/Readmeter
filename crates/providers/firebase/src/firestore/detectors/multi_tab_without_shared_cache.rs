use readmeter_core::{CacheKind, Envelope, Op, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/multi-tab-without-shared-cache";

pub fn build(_p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(MultiTabWithoutSharedCache))
}

/// Single-tab persistent cache: each open tab bills its own listeners.
struct MultiTabWithoutSharedCache;

impl Detector for MultiTabWithoutSharedCache {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Init || env.ctx.platform != Platform::Browser {
            return;
        }
        let Some(setup) = env.setup else {
            return;
        };
        if setup.cache != CacheKind::Persistent || setup.shared_tabs {
            return;
        }
        out.emit(
            env,
            "persistent cache without a multi-tab manager; each open tab keeps its own listeners and re-reads their results",
        );
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::ClientSetup;
    use readmeter_rules::testing::{EnvBuilder, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[])
    }

    fn init(cache: CacheKind, shared_tabs: bool, platform: Platform) -> Envelope {
        EnvBuilder::new(Op::Init, "")
            .init(ClientSetup { cache, shared_tabs })
            .platform(platform)
            .build()
    }

    #[test]
    fn flags_a_single_tab_persistent_cache() {
        let mut e = engine();
        let f = run(
            &mut e,
            [init(CacheKind::Persistent, false, Platform::Browser)],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "persistent cache without a multi-tab manager; each open tab keeps its own listeners and re-reads their results"
        );
        assert!(f[0].evidence.is_empty());
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn ignores_shared_memory_and_server() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                [
                    init(CacheKind::Persistent, true, Platform::Browser),
                    init(CacheKind::Memory, false, Platform::Browser),
                    init(CacheKind::Persistent, false, Platform::Server),
                    init(CacheKind::Unknown, false, Platform::Browser),
                ]
            )
            .is_empty()
        );
    }
}
