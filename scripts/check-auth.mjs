// Checks the Authentication-Results parser in api.js without Thunderbird.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {
  ChromeUtils: { importESModule: () => ({ ExtensionCommon: { ExtensionAPI: class {} } }) },
  // Two-label organisational domains are enough for these fixtures.
  Services: { eTLD: { getBaseDomainFromHost: host => host.split(".").slice(-2).join(".") } },
};
vm.runInNewContext(
  readFileSync(new URL("../experiments/mail-list/api.js", import.meta.url), "utf8"),
  context
);
const check = field => context.senderAuthenticated(field, "paypal.com");

// Gmail: DMARC pass; the SPF comment contains a colon and an address.
assert.equal(check("Authentication-Results: mx.google.com; dkim=pass header.i=@paypal.com header.s=s1 header.b=Ab; spf=pass (google.com: domain of x@paypal.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@paypal.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=paypal.com"), true);
// Microsoft: no authserv-id, results packed without spaces.
assert.equal(check("Authentication-Results: spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=paypal.com; dkim=pass (signature was verified) header.d=paypal.com;dmarc=pass action=none header.from=paypal.com;compauth=pass reason=100"), true);
// Relaxed DKIM alignment; the comment's ";" must not split the result.
assert.equal(check("Authentication-Results: mx.example.org; dkim=pass (1024-bit key; unprotected) header.d=news.paypal.com header.s=s1"), true);
// A failing DMARC verdict wins over an unaligned DKIM pass.
assert.equal(check("Authentication-Results: mx.example.org; dkim=pass header.d=evil.com; dmarc=fail (p=REJECT) header.from=paypal.com"), false);
// DKIM pass for another organisation and DMARC pass for another From.
assert.equal(check("Authentication-Results: mx.example.org; dkim=pass header.d=paypal.com.evil.com"), false);
assert.equal(check("Authentication-Results: mx.example.org; dmarc=pass header.from=evil.com"), false);
// Sender-chosen quoted local part must not inject a result.
assert.equal(check('Authentication-Results: mx.example.org; spf=pass smtp.mailfrom="x;dmarc=pass header.from=paypal.com;"@evil.com'), false);
assert.equal(check("Authentication-Results: mx.example.org; none"), false);
