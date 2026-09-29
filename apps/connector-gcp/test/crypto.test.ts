import assert from "node:assert/strict";
import test from "node:test";

import { toMicros } from "../src/billing.ts";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";
import { billingTableError, parseServiceAccount, quoteBillingTable } from "../src/validate.ts";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
const other = Buffer.from("fedcba9876543210fedcba9876543210");

test("encryption round trip and a wrong key fails", () => {
  const sealed = encryptSecret('{"private_key":"SUPER-SECRET-PRIVATE-KEY"}', key);
  assert.equal(decryptSecret(sealed, key), '{"private_key":"SUPER-SECRET-PRIVATE-KEY"}');
  assert.equal(sealed.ciphertext.includes("SUPER-SECRET-PRIVATE-KEY"), false);
  assert.throws(() => decryptSecret(sealed, other));
});

test("service account JSON is rejected unless it has the required shape", () => {
  const good = parseServiceAccount({
    type: "service_account",
    client_email: "reader@demo-readmeter.iam.gserviceaccount.com",
    private_key: "fake-private-key",
    project_id: "demo-readmeter",
  });
  assert.equal("account" in good, true);
  const invalid = parseServiceAccount("{");
  const wrongType = parseServiceAccount({ type: "user" });
  const huge = parseServiceAccount("x".repeat(20_000));
  assert.equal("error" in invalid ? invalid.error : "", "service account JSON is not valid JSON");
  assert.equal("error" in wrongType ? wrongType.error : "", 'type must be "service_account"');
  assert.equal("error" in huge ? huge.error : "", "service account JSON must be at most 16 KiB");
});

test("billing table names are quoted and injection is rejected", () => {
  assert.equal(billingTableError("demo-readmeter.billing.gcp_billing_export_v1"), null);
  assert.equal(
    quoteBillingTable("demo-readmeter.billing.gcp_billing_export_v1"),
    "`demo-readmeter`.`billing`.`gcp_billing_export_v1`",
  );
  assert.ok(billingTableError("proj.dataset.table;drop table x"));
  assert.throws(() => quoteBillingTable("not a table"));
});

test("billing money becomes integer micros", () => {
  assert.equal(toMicros(1.25), 1_250_000);
  assert.equal(toMicros(-0.25), -250_000);
  assert.equal(toMicros(Number.NaN), 0);
});
