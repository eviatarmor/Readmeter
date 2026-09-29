/* Smoke test for the C ABI: create a client, record one call, flush, free. */
#include <stdio.h>
#include <string.h>

#include "readmeter.h"

static const char *CONFIG =
    "{\"provider\":\"firebase\",\"sdk\":{\"name\":\"readmeter-c-smoke\",\"version\":\"0\"},"
    "\"session\":1,\"hash_key\":\"000102030405060708090a0b0c0d0e0f\",\"platform\":\"server\"}";

static const char *CALL =
    "{\"service\":\"firestore\",\"op\":\"query\",\"ts_ms\":1,\"path\":\"posts\","
    "\"query\":{\"limit\":20,\"offset\":200},\"result\":{\"docs\":20,\"bytes\":2000}}";

static int fail(const char *what) {
  RmBuf err = {0};
  rm_last_error(&err);
  fprintf(stderr, "%s failed: %.*s\n", what, (int)err.len, (const char *)err.ptr);
  rm_buf_free(err);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: smoke <bundle.bin>\n");
    return 2;
  }
  FILE *f = fopen(argv[1], "rb");
  if (!f) return fail("open bundle");
  static char bundle[1 << 20];
  size_t bundle_len = fread(bundle, 1, sizeof bundle, f);
  fclose(f);

  RmClient *client = NULL;
  if (rm_client_new((const uint8_t *)CONFIG, strlen(CONFIG), (const uint8_t *)bundle,
                    bundle_len, &client) != RM_STATUS_OK)
    return fail("rm_client_new");

  RmBuf findings = {0};
  if (rm_client_record(client, (const uint8_t *)CALL, strlen(CALL), &findings) != RM_STATUS_OK)
    return fail("rm_client_record");
  int found = strstr((const char *)findings.ptr, "offset-pagination") != NULL;
  rm_buf_free(findings);

  RmBuf batch = {0};
  if (rm_client_flush(client, 2, &batch) != RM_STATUS_OK) return fail("rm_client_flush");
  int batch_ok = batch.len > 4 && batch.ptr[0] == 'R' && batch.ptr[1] == 'M';
  size_t batch_len = batch.len;
  rm_buf_free(batch);
  rm_client_free(client);

  if (!found || !batch_ok) {
    fprintf(stderr, "unexpected result: found=%d batch_ok=%d\n", found, batch_ok);
    return 1;
  }
  printf("ok: offset-pagination reported, batch %zu B\n", batch_len);
  return 0;
}
