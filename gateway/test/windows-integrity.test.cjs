const assert = require("node:assert/strict");
const test = require("node:test");
const {
  stripWindowsSxSNumericDependencies,
} = require("../runner/platform/windows-integrity.cjs");

test("Windows runner manifest removes private Chromium SxS dependencies", () => {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" publicKeyToken="6595b64144ccf1df" />
    </dependentAssembly>
  </dependency>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="155.0.8059.80" version="155.0.8059.80" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>`;

  const repaired = stripWindowsSxSNumericDependencies(manifest);
  assert.doesNotMatch(repaired, /155\.0\.8059\.80/);
  assert.match(repaired, /Microsoft\.Windows\.Common-Controls/);
  assert.equal(stripWindowsSxSNumericDependencies(repaired), repaired);
});

test("Windows runner manifest keeps publisher-signed numeric assembly dependencies", () => {
  const manifest = `<assembly>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="10.0.0.1" version="10.0.0.1" publicKeyToken="abc" />
    </dependentAssembly>
  </dependency>
</assembly>`;
  assert.equal(stripWindowsSxSNumericDependencies(manifest), manifest);
});
