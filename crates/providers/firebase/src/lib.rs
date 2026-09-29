//! Firebase provider.
//!
//! Services are cargo features so SDK builds only carry what they wrap.
//! Firestore, Realtime Database, Cloud Storage, Authentication, and
//! Cloud Functions are implemented.

use readmeter_core::Envelope;
use readmeter_provider_api::json::{self, JsonTypeError};
use readmeter_provider_api::{NormalizeContext, NormalizeError, Provider};
use readmeter_rules::DetectorFactory;

#[cfg(feature = "auth")]
pub mod auth;
#[cfg(feature = "database")]
pub mod database;
#[cfg(feature = "firestore")]
pub mod firestore;
#[cfg(feature = "functions")]
pub mod functions;
#[cfg(feature = "storage")]
pub mod storage;

pub const PROVIDER_ID: &str = "firebase";

#[derive(Debug, Default, Clone, Copy)]
pub struct FirebaseProvider;

impl Provider for FirebaseProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn services(&self) -> &'static [&'static str] {
        &[
            #[cfg(feature = "database")]
            database::SERVICE_ID,
            #[cfg(feature = "firestore")]
            firestore::SERVICE_ID,
            #[cfg(feature = "storage")]
            storage::SERVICE_ID,
            #[cfg(feature = "auth")]
            auth::SERVICE_ID,
            #[cfg(feature = "functions")]
            functions::SERVICE_ID,
        ]
    }

    fn normalize_value(
        &self,
        value: &readmeter_provider_api::JsonValue,
        cx: &NormalizeContext,
    ) -> Result<Envelope, NormalizeError> {
        let service = match json::get_str(value, "service") {
            Ok(Some(s)) => s,
            Ok(None) => return Err(NormalizeError::Invalid("missing `service`".into())),
            Err(JsonTypeError::NotObject) => {
                return Err(NormalizeError::Invalid("expected object".into()));
            }
            Err(_) => return Err(NormalizeError::Invalid("`service`: wrong type".into())),
        };
        match service {
            #[cfg(feature = "database")]
            database::SERVICE_ID => database::normalize(database::RawCall::from_json(value)?, cx),
            #[cfg(feature = "firestore")]
            firestore::SERVICE_ID => {
                firestore::normalize(firestore::RawCall::from_json(value)?, cx)
            }
            #[cfg(feature = "storage")]
            storage::SERVICE_ID => storage::normalize(storage::RawCall::from_json(value)?, cx),
            #[cfg(feature = "auth")]
            auth::SERVICE_ID => auth::normalize(auth::RawCall::from_json(value)?, cx),
            #[cfg(feature = "functions")]
            functions::SERVICE_ID => {
                functions::normalize(functions::RawCall::from_json(value)?, cx)
            }
            other => Err(NormalizeError::UnknownService(other.to_owned())),
        }
    }

    fn detectors(&self) -> Vec<(&'static str, DetectorFactory)> {
        let mut out = Vec::new();
        #[cfg(feature = "database")]
        out.extend(database::detectors::all());
        #[cfg(feature = "firestore")]
        out.extend(firestore::detectors::all());
        #[cfg(feature = "storage")]
        out.extend(storage::detectors::all());
        #[cfg(feature = "auth")]
        out.extend(auth::detectors::all());
        #[cfg(feature = "functions")]
        out.extend(functions::detectors::all());
        out
    }
}
