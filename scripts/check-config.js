import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
for (const file of ["compose.yaml", ".github/workflows/ci.yml"]) {
  const doc = parseDocument(await readFile(file, "utf8"));
  assert.equal(doc.errors.length, 0, JSON.stringify(doc.errors));
  const value = doc.toJS();
  if (file === "compose.yaml") {
    assert.ok(value.services.db);
    assert.ok(value.services.migrate);
    assert.ok(value.services.worker);
    assert.equal(value.services.db.ports, undefined);
  } else {
    assert.equal(value.permissions.contents, "read");
    assert.ok(value.jobs.verify.services.postgres);
    assert.equal(value.on.pull_request, null);
  }
  console.log(`${file}: YAML and required configuration checks passed`);
}
