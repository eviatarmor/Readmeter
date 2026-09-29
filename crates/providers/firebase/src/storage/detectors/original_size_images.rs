use readmeter_core::{Envelope, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::attr;
use super::billed;
use super::named;
use crate::storage::normalize::ext_is_image;

pub const ID: &str = "firebase.storage/original-size-images";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(OriginalSizeImages {
        max_image_bytes: p.u64("max_image_bytes")?.max(1),
    }))
}

/// A browser download of an image larger than a screen needs.
///
/// Content type wins. When the call did not observe one (for example
/// `getBytes`, which returns only an `ArrayBuffer`), a known image
/// extension is enough. `application/octet-stream` is not an image, even
/// when the name ends in `.jpg`.
struct OriginalSizeImages {
    max_image_bytes: u64,
}

impl Detector for OriginalSizeImages {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "download") || !billed(env) || env.ctx.platform != Platform::Browser {
            return;
        }
        if !is_image(env) {
            return;
        }
        let bytes = env.bytes();
        if bytes <= self.max_image_bytes {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` image download is {bytes} bytes; resize it or serve a thumbnail",
                env.target.template
            ),
        )
        .evidence("bytes", bytes);
    }
}

fn is_image(env: &Envelope) -> bool {
    match attr(env, "content_type") {
        Some("image") => true,
        Some(_) => false,
        None => attr(env, "ext").is_some_and(ext_is_image),
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Op, Platform};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("max_image_bytes", int(1_048_576))])
    }

    fn download(bytes: u64, filters: &[(&str, &str)], platform: Platform) -> Envelope {
        EnvBuilder::new(Op::Other("download".into()), "photos/banner.png")
            .provider("firebase", "storage")
            .bytes(bytes)
            .platform(platform)
            .with_query(|q| {
                for (field, op) in filters {
                    q.filters.push(FilterShape {
                        field: (*field).to_owned(),
                        op: (*op).to_owned(),
                    });
                }
            })
            .build()
    }

    #[test]
    fn flags_a_browser_image_over_the_limit() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                [download(
                    1_048_576,
                    &[("content_type", "image")],
                    Platform::Browser
                )]
            )
            .is_empty()
        );
        let mut hot = engine();
        assert_eq!(
            run(
                &mut hot,
                [download(
                    1_048_577,
                    &[("content_type", "image")],
                    Platform::Browser
                )]
            )
            .len(),
            1
        );
    }

    #[test]
    fn extension_is_a_fallback_and_metadata_wins() {
        let mut ext = engine();
        assert_eq!(
            run(
                &mut ext,
                [download(1_048_577, &[("ext", "jpg")], Platform::Browser)]
            )
            .len(),
            1
        );
        let mut video = engine();
        assert!(
            run(
                &mut video,
                [download(
                    1_048_577,
                    &[("content_type", "video"), ("ext", "jpg")],
                    Platform::Browser
                )]
            )
            .is_empty()
        );
        let mut octet = engine();
        assert!(
            run(
                &mut octet,
                [download(
                    1_048_577,
                    &[("content_type", "application"), ("ext", "jpg")],
                    Platform::Browser
                )]
            )
            .is_empty()
        );
        let mut server = engine();
        assert!(
            run(
                &mut server,
                [download(
                    1_048_577,
                    &[("content_type", "image")],
                    Platform::Server
                )]
            )
            .is_empty()
        );
    }
}
