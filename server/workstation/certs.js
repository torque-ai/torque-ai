// mTLS Certificate Helpers — fingerprinting and expiry detection

'use strict';

const crypto = require('crypto');

const DEFAULT_LIFETIME_DAYS = 365;
const EXPIRY_WARNING_DAYS = 30;

function getCertFingerprint(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return x509.fingerprint256;
  } catch {
    const hash = crypto.createHash('sha256').update(certPem).digest('hex');
    return hash.match(/.{2}/g).join(':').toUpperCase();
  }
}

function isCertExpiringSoon(expiresAt, warningDays = EXPIRY_WARNING_DAYS) {
  const expiry = new Date(expiresAt);
  const warningDate = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);
  return expiry <= warningDate;
}

module.exports = {
  getCertFingerprint,
  isCertExpiringSoon,
  DEFAULT_LIFETIME_DAYS,
  EXPIRY_WARNING_DAYS,
};
