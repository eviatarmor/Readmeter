//! Firebase provider.
//!
//! Services are cargo features so SDK builds only carry what they wrap.
//! Firestore is the first service; Realtime Database, Storage and Functions
//! slot in as sibling modules.

use readmeter_core::Envelope;
use readmeter_provider_api::json::{self, JsonTypeError};
use readmeter_provider_api::{NormalizeContext, NormalizeError, Provider};
use readmeter_rules::DetectorFactory;

#[cfg(feature = "firestore")]
pub mod firestore;

pub const PROVIDER_ID: &str = "firebase";

#[derive(Debug, Default, Clone, Copy)]
pub struct FirebaseProvider;

impl Provider for FirebaseProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn services(&self) -> &'static [&'static str] {
        &[
            #[cfg(feature = "firestore")]
            firestore::SERVICE_ID,
        ]
    }

    fn normalize(
        &self,
        raw_json: &[u8],
        cx: &NormalizeContext,
    ) -> Result<Envelope, NormalizeError> {
        let value = json::parse(raw_json)?;
        let service = match json::get_str(&value, "service") {
            Ok(Some(s)) => s,
            Ok(None) => return Err(NormalizeError::Invalid("missing `service`".into())),
            Err(JsonTypeError::NotObject) => {
                return Err(NormalizeError::Invalid("expected object".into()));
            }
            Err(_) => return Err(NormalizeError::Invalid("`service`: wrong type".into())),
        };
        match service {
            #[cfg(feature = "firestore")]
            firestore::SERVICE_ID => {
                firestore::normalize(firestore::RawCall::from_json(&value)?, cx)
            }
            other => Err(NormalizeError::UnknownService(other.to_owned())),
        }
    }

    fn detectors(&self) -> Vec<(&'static str, DetectorFactory)> {
        let mut out = Vec::new();
        #[cfg(feature = "firestore")]
        out.extend(firestore::detectors::all());
        out
    }
}
