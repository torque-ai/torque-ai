const http = require('http');
const os = require('os');

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
  });
}

describe('gpu-metrics-server CPU/RAM', () => {
  let mod;

  beforeEach(() => {
    const modPath = require.resolve('../scripts/gpu-metrics-server');
    delete require.cache[modPath];
    mod = require('../scripts/gpu-metrics-server');
  });

  describe('getCpuPercent', () => {
    it('returns a number between 0 and 100', () => {
      const result = mod.getCpuPercent();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });

    it('returns null when os.cpus returns empty array', () => {
      const orig = os.cpus;
      os.cpus = () => [];
      try {
        const result = mod.getCpuPercent();
        expect(result).toBeNull();
      } finally {
        os.cpus = orig;
      }
    });
  });

  describe('getRamPercent', () => {
    it('returns memory usage percentage', () => {
      const origTotal = os.totalmem;
      const origFree = os.freemem;
      os.totalmem = () => 400;
      os.freemem = () => 100;
      try {
        const result = mod.getRamPercent();
        expect(result).toBe(75);
      } finally {
        os.totalmem = origTotal;
        os.freemem = origFree;
      }
    });

    it('returns 0 when totalmem is 0', () => {
      const origTotal = os.totalmem;
      os.totalmem = () => 0;
      try {
        const result = mod.getRamPercent();
        expect(result).toBe(0);
      } finally {
        os.totalmem = origTotal;
      }
    });
  });

  describe('/metrics', () => {
    it('includes cpuPercent and ramPercent', async () => {
      const server = mod.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const address = server.address();
        const { statusCode, body } = await getJson(address.port, '/metrics');

        expect(statusCode).toBe(200);
        expect(body).toHaveProperty('cpuPercent');
        expect(body).toHaveProperty('ramPercent');
        expect(typeof body.cpuPercent).toBe('number');
        expect(typeof body.ramPercent).toBe('number');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
