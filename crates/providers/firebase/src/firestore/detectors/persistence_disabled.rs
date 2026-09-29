use readmeter_core::{CacheKind, Envelope, Op, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/persistence-disabled";

pub fn build(_p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(PersistenceDisabled))
}

/// Browser client configured with a memory-only cache.
struct PersistenceDisabled;

impl Detector for PersistenceDisabled {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Init || env.ctx.platform != Platform::Browser {
            return;
        }
        let Some(setup) = env.setup else {
            return;
        };
        if setup.cache != CacheKind::Memory {
            return;
        }
        out.emit(
            env,
            "Firestore runs with a memory-only cache; every page load re-reads all data from the server",
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

    fn init(cache: CacheKind, platform: Platform) -> Envelope {
        EnvBuilder::new(Op::Init, "")
            .init(ClientSetup {
                cache,
                shared_tabs: false,
            })
            .platform(platform)
            .build()
    }

    #[test]
    fn flags_a_memory_cache_in_the_browser() {
        let mut e = engine();
        let f = run(&mut e, [init(CacheKind::Memory, Platform::Browser)]);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "Firestore runs with a memory-only cache; every page load re-reads all data from the server"
        );
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn ignores_persistent_unknown_and_server() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                [
                    init(CacheKind::Persistent, Platform::Browser),
                    init(CacheKind::Unknown, Platform::Browser),
                    init(CacheKind::Memory, Platform::Server),
                ]
            )
            .is_empty()
        );
    }
}
