use readmeter_core::{CacheKind, Envelope, Op, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.auth/memory-persistence";

pub fn build(_p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(MemoryPersistence))
}

/// Browser auth configured with in-memory persistence.
struct MemoryPersistence;

impl Detector for MemoryPersistence {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Init || env.ctx.platform != Platform::Browser || env.outcome.is_error() {
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
            "auth is using in-memory persistence; the user is signed out on every page load",
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
        EnvBuilder::new(Op::Init, "auth/setPersistence")
            .provider("firebase", "auth")
            .init(ClientSetup {
                cache,
                shared_tabs: false,
            })
            .platform(platform)
            .build()
    }

    #[test]
    fn flags_memory_persistence_in_the_browser() {
        let mut e = engine();
        let findings = run(&mut e, [init(CacheKind::Memory, Platform::Browser)]);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].wasted.is_empty());
    }

    #[test]
    fn ignores_persistent_unknown_server_and_errors() {
        let mut e = engine();
        let failed = EnvBuilder::new(Op::Init, "auth/initializeAuth")
            .provider("firebase", "auth")
            .init(ClientSetup {
                cache: CacheKind::Memory,
                shared_tabs: false,
            })
            .platform(Platform::Browser)
            .error("invalid-persistence-type");
        assert!(
            run(
                &mut e,
                [
                    init(CacheKind::Persistent, Platform::Browser),
                    init(CacheKind::Unknown, Platform::Browser),
                    init(CacheKind::Memory, Platform::Server),
                    failed.build(),
                ]
            )
            .is_empty()
        );
    }
}
