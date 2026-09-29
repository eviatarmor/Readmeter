use std::collections::HashMap;

use readmeter_core::{Envelope, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.auth/server-list-users-in-request";

const MAX_TRACKED: usize = 16_384;

pub fn build(_p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ServerListUsers {
        seen: HashMap::new(),
    }))
}

/// `listUsers` inside a request. The invocation id is carried on
/// `ctx.transaction` (there is no invocation field on the envelope).
/// Pagination inside one invocation is one finding. Calls outside
/// `withFlush` have no invocation and do not fire.
struct ServerListUsers {
    seen: HashMap<(u64, u64), ()>,
}

impl Detector for ServerListUsers {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "list_users") || !billed(env) || env.ctx.platform != Platform::Server {
            return;
        }
        let Some(invocation) = env.ctx.transaction else {
            return;
        };
        let key = (env.ctx.session, invocation);
        if self.seen.len() >= MAX_TRACKED && !self.seen.contains_key(&key) {
            self.seen.clear();
        }
        if self.seen.insert(key, ()).is_some() {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` listed users inside a request; list users from a job, not a request handler",
                env.target.template
            ),
        )
        .evidence("items", env.items());
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

    fn listed(invocation: Option<u64>, platform: Platform) -> EnvBuilder {
        let mut call = EnvBuilder::new(Op::Other("list_users".into()), "auth/listUsers")
            .provider("firebase", "auth")
            .platform(platform)
            .items(0);
        if let Some(id) = invocation {
            call = call.transaction(id);
        }
        call
    }

    #[test]
    fn flags_the_first_list_in_an_invocation() {
        let mut e = engine();
        let findings = run(
            &mut e,
            [
                listed(Some(1), Platform::Server).build(),
                listed(Some(1), Platform::Server).build(),
                listed(Some(2), Platform::Server).build(),
            ],
        );
        assert_eq!(findings.len(), 2);
        assert!(findings.iter().all(|f| f.wasted.is_empty()));
    }

    #[test]
    fn ignores_browser_calls_and_calls_outside_a_request() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                [
                    listed(None, Platform::Server).build(),
                    listed(Some(1), Platform::Browser).build(),
                    listed(Some(1), Platform::Server)
                        .error("insufficient-permission")
                        .build(),
                ]
            )
            .is_empty()
        );
    }
}
