//! Firebase Auth error codes from `@firebase/auth` 1.13.6 (`AuthErrorCodes`)
//! and `firebase-admin` 14.5.0 (`AuthErrorCode`). One newline-separated
//! blob, sorted, so the wasm keeps the text without a pointer per code.
//! The last path segment is kept only when it is one of these. Anything
//! else (`user@host`, a uid, a token) becomes `unknown`.

pub(super) const ERROR_CODES: &str = "\
account-exists-with-different-credential\n\
admin-restricted-operation\n\
already-initialized\n\
app-deleted\n\
app-not-authorized\n\
app-not-installed\n\
argument-error\n\
auth-blocking-token-expired\n\
auth-domain-config-required\n\
billing-not-enabled\n\
cancelled-popup-request\n\
captcha-check-failed\n\
claims-too-large\n\
code-expired\n\
configuration-exists\n\
configuration-not-found\n\
cordova-not-ready\n\
cors-unsupported\n\
credential-already-in-use\n\
custom-token-mismatch\n\
dependent-sdk-initialized-before-auth\n\
dynamic-link-not-activated\n\
email-already-exists\n\
email-already-in-use\n\
email-change-needs-verification\n\
email-not-found\n\
emulator-config-failed\n\
expired-action-code\n\
id-token-expired\n\
id-token-revoked\n\
insufficient-permission\n\
internal-error\n\
invalid-action-code\n\
invalid-api-key\n\
invalid-app-credential\n\
invalid-app-id\n\
invalid-auth-event\n\
invalid-cert-hash\n\
invalid-claims\n\
invalid-config\n\
invalid-continue-uri\n\
invalid-cordova-configuration\n\
invalid-creation-time\n\
invalid-credential\n\
invalid-custom-token\n\
invalid-disabled-field\n\
invalid-display-name\n\
invalid-dynamic-link-domain\n\
invalid-email\n\
invalid-email-verified\n\
invalid-emulator-scheme\n\
invalid-enrolled-factors\n\
invalid-enrollment-time\n\
invalid-hash-algorithm\n\
invalid-hash-block-size\n\
invalid-hash-derived-key-length\n\
invalid-hash-key\n\
invalid-hash-memory-cost\n\
invalid-hash-parallelization\n\
invalid-hash-rounds\n\
invalid-hash-salt-separator\n\
invalid-hosting-link-domain\n\
invalid-id-token\n\
invalid-last-sign-in-time\n\
invalid-message-payload\n\
invalid-multi-factor-session\n\
invalid-name\n\
invalid-new-email\n\
invalid-oauth-client-id\n\
invalid-oauth-provider\n\
invalid-oauth-responsetype\n\
invalid-page-token\n\
invalid-password\n\
invalid-password-hash\n\
invalid-password-salt\n\
invalid-persistence-type\n\
invalid-phone-number\n\
invalid-photo-url\n\
invalid-project-id\n\
invalid-provider-data\n\
invalid-provider-id\n\
invalid-provider-uid\n\
invalid-recaptcha-action\n\
invalid-recaptcha-enforcement-state\n\
invalid-recaptcha-token\n\
invalid-recaptcha-version\n\
invalid-recipient-email\n\
invalid-req-type\n\
invalid-sender\n\
invalid-session-cookie-duration\n\
invalid-tenant-id\n\
invalid-tenant-type\n\
invalid-testing-phone-number\n\
invalid-tokens-valid-after-time\n\
invalid-uid\n\
invalid-user-import\n\
invalid-user-token\n\
invalid-verification-code\n\
invalid-verification-id\n\
maximum-second-factor-count-exceeded\n\
maximum-user-count-exceeded\n\
mismatching-tenant-id\n\
missing-android-package-name\n\
missing-android-pkg-name\n\
missing-app-credential\n\
missing-client-type\n\
missing-config\n\
missing-continue-uri\n\
missing-display-name\n\
missing-email\n\
missing-hash-algorithm\n\
missing-iframe-start\n\
missing-ios-bundle-id\n\
missing-issuer\n\
missing-multi-factor-info\n\
missing-multi-factor-session\n\
missing-oauth-client-id\n\
missing-oauth-client-secret\n\
missing-or-invalid-nonce\n\
missing-password\n\
missing-phone-number\n\
missing-provider-id\n\
missing-recaptcha-token\n\
missing-recaptcha-version\n\
missing-saml-relying-party-config\n\
missing-uid\n\
missing-verification-code\n\
missing-verification-id\n\
multi-factor-auth-required\n\
multi-factor-info-not-found\n\
network-request-failed\n\
no-auth-event\n\
no-such-provider\n\
not-found\n\
null-user\n\
operation-not-allowed\n\
operation-not-supported-in-this-environment\n\
phone-number-already-exists\n\
popup-blocked\n\
popup-closed-by-user\n\
project-not-found\n\
provider-already-linked\n\
quota-exceeded\n\
recaptcha-not-enabled\n\
redirect-cancelled-by-user\n\
redirect-operation-pending\n\
rejected-credential\n\
requires-recent-login\n\
reserved-claim\n\
second-factor-already-in-use\n\
second-factor-limit-exceeded\n\
second-factor-uid-already-exists\n\
session-cookie-expired\n\
session-cookie-revoked\n\
tenant-id-mismatch\n\
tenant-not-found\n\
test-phone-number-limit-exceeded\n\
timeout\n\
too-many-requests\n\
uid-already-exists\n\
unauthorized-continue-uri\n\
unauthorized-domain\n\
unsupported-first-factor\n\
unsupported-persistence-type\n\
unsupported-second-factor\n\
unsupported-tenant-operation\n\
unverified-email\n\
user-cancelled\n\
user-disabled\n\
user-mismatch\n\
user-not-disabled\n\
user-not-found\n\
user-signed-out\n\
user-token-expired\n\
weak-password\n\
web-storage-unsupported\n\
wrong-password";

pub(super) fn is_error_code(code: &str) -> bool {
    let mut rest = ERROR_CODES;
    while !rest.is_empty() {
        let (line, next) = match rest.split_once('\n') {
            Some(pair) => pair,
            None => (rest, ""),
        };
        if line == code {
            return true;
        }
        if line > code {
            return false;
        }
        rest = next;
    }
    false
}

#[cfg(test)]
pub(super) fn error_codes() -> impl Iterator<Item = &'static str> {
    ERROR_CODES.split('\n').filter(|line| !line.is_empty())
}
