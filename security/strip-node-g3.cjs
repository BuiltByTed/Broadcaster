'use strict';
// Change only the serialized public CA data in ELF Node executables. Keep all
// code, offsets, string lengths, ownership and other roots unchanged.
// The removed slot repeats an already trusted root; unique trust drops by one.
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const target = '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b';
const targets = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath];
for (const supplied of new Set(targets)) {
  const file = fs.realpathSync(supplied);
  const before = fs.readFileSync(file);
  if (before.subarray(0, 4).toString('hex') !== '7f454c46') continue;
  const text = before.toString('latin1');
  const certificates = [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].flatMap(match => {
    try {
      const cert = new crypto.X509Certificate(match[0]);
      return [{ index: match.index, pem: match[0], fingerprint: crypto.createHash('sha256').update(cert.raw).digest('hex') }];
    } catch { return []; }
  });
  const removed = certificates.filter(c => c.fingerprint === target);
  if (!removed.length) { console.log(JSON.stringify({file, removed: 0})); continue; }
  const originalRoots = JSON.parse(cp.execFileSync(file, ['-e', 'console.log(JSON.stringify(require("tls").rootCertificates))'],
    {encoding: 'utf8', env: {...process.env, NODE_OPTIONS: ''}, maxBuffer: 4 * 1024 * 1024}));
  const trusted = new Set(originalRoots.map(p => crypto.createHash('sha256').update(new crypto.X509Certificate(p).raw).digest('hex')));
  const replacement = certificates.filter(c => c.fingerprint !== target && trusted.has(c.fingerprint)).sort((a,b) => a.pem.length-b.pem.length)[0];
  if (!replacement || removed.some(c => replacement.pem.length > c.pem.length)) throw new Error('No existing shorter trusted certificate slot');
  const after = Buffer.from(before);
  for (const cert of removed) {
    const data = replacement.pem.padEnd(cert.pem.length, '\n');
    after.write(data, cert.index, cert.pem.length, 'latin1');
  }
  if (after.length !== before.length) throw new Error('Executable length changed');
  const stat = fs.statSync(file), temp = file + '.g3-ca-data.tmp';
  fs.writeFileSync(temp, after, {mode: stat.mode});
  fs.chownSync(temp, stat.uid, stat.gid); fs.chmodSync(temp, stat.mode);
  fs.renameSync(temp, file);
  console.log(JSON.stringify({file, removed: removed.length, replacement: replacement.fingerprint,
    before_sha256:crypto.createHash('sha256').update(before).digest('hex'), after_sha256:crypto.createHash('sha256').update(after).digest('hex')}));
}
