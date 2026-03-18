/**
 * TORQUE Performance Benchmark Tool
 * Tests local LLM throughput and finds optimal configuration
 *
 * Can be used standalone or integrated with TORQUE's host system
 */

const http = require('http');
const path = require('path');
const os = require('os');

// Try to load TORQUE database for host discovery
let db = null;
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(os.homedir(), '.local', 'share', 'torque', 'tasks.db');
  db = new Database(dbPath, { readonly: true });
} catch {
  // Running standalone without TORQUE database
}

/**
 * Get all configured Ollama hosts from TORQUE database
 * @returns {Array<{id: number, name: string, url: string, enabled: number, status: string, models_cache: string}>} Array of enabled host records, or empty array if unavailable
 */
function getConfiguredHosts() {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT id, name, url, enabled, status, models_cache
      FROM ollama_hosts
      WHERE enabled = 1
    `).all();
  } catch {
    return [];
  }
}

/**
 * Get models available on a specific host
 * @param {string} hostUrl - Base URL of the Ollama host (e.g. 'http://localhost:11434')
 * @returns {Promise<string[]>} Array of model names, or empty array on failure
 */
async function getHostModels(hostUrl) {
  try {
    const response = await ollamaGet(hostUrl, '/api/tags');
    return response.models?.map(m => m.name) || [];
  } catch {
    return [];
  }
}

// Test prompts of varying complexity
const TEST_PROMPTS = {
  simple: 'Write a function that adds two numbers.',
  medium: 'Write a TypeScript function that validates an email address with regex and returns an object with isValid boolean and any errors.',
  complex: `Write a complete TypeScript class for a task queue system with:
1. Priority-based ordering
2. Retry logic with exponential backoff
3. Concurrent execution limit
4. Event emitters for task lifecycle
Include full type definitions and JSDoc comments.`
};

/**
 * Make HTTP GET request to Ollama API
 * @param {string} host - Base URL of the Ollama host
 * @param {string} endpoint - API endpoint path (e.g. '/api/tags')
 * @returns {Promise<Object|string>} Parsed JSON response, or raw string if not valid JSON
 */
function ollamaGet(host, endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, host);
    const options = {
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'GET',
      timeout: 10000
    };

    const MAX_RESPONSE = 10 * 1024 * 1024; // 10MB limit
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE) { res.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Make HTTP POST request to Ollama API
 * @param {string} host - Base URL of the Ollama host
 * @param {string} endpoint - API endpoint path (e.g. '/api/generate')
 * @param {Object} body - Request body to send as JSON
 * @returns {Promise<{response: Object|string, rawLines: number}>} Parsed last line of streaming response and line count
 */
function ollamaRequest(host, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, host);
    const options = {
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 300000 // 5 minute timeout
    };

    const MAX_RESPONSE = 50 * 1024 * 1024; // 50MB limit for streaming responses
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE) { res.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => {
        try {
          // Handle streaming responses (each line is JSON)
          const lines = data.trim().split('\n');
          const lastLine = JSON.parse(lines[lines.length - 1]);
          resolve({ response: lastLine, rawLines: lines.length });
        } catch {
          resolve({ response: data, rawLines: 1 });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Run a single benchmark test
 * @param {string} host - Base URL of the Ollama host
 * @param {string} model - Model name to benchmark
 * @param {string} prompt - Prompt to evaluate
 * @param {Object} [options] - Benchmarking options
 * @returns {Object} Benchmark result object with success status and performance metrics
 */
async function runBenchmark(host, model, prompt, options = {}) {
  const startTime = Date.now();

  try {
    const body = {
      model,
      prompt,
      stream: false,
      options: {
        num_gpu: options.num_gpu ?? -1,
        num_ctx: options.num_ctx ?? 8192,
        num_thread: options.num_thread ?? 0,
        temperature: 0.3,
        ...options
      }
    };

    const result = await ollamaRequest(host, '/api/generate', body);
    const endTime = Date.now();

    const response = result.response;
    const totalDuration = response.total_duration / 1e9; // nanoseconds to seconds
    const loadDuration = response.load_duration / 1e9;
    const promptEvalDuration = response.prompt_eval_duration / 1e9;
    const evalDuration = response.eval_duration / 1e9;
    const promptTokens = response.prompt_eval_count || 0;
    const outputTokens = response.eval_count || 0;

    const tokensPerSecond = evalDuration > 0 ? outputTokens / evalDuration : 0;
    const promptTokensPerSecond = promptEvalDuration > 0 ? promptTokens / promptEvalDuration : 0;

    return {
      success: true,
      model,
      promptType: getPromptType(prompt),
      wallTime: (endTime - startTime) / 1000,
      totalDuration,
      loadDuration,
      promptEvalDuration,
      evalDuration,
      promptTokens,
      outputTokens,
      tokensPerSecond: tokensPerSecond.toFixed(2),
      promptTokensPerSecond: promptTokensPerSecond.toFixed(2),
      options: body.options
    };
  } catch (error) {
    return {
      success: false,
      model,
      promptType: getPromptType(prompt),
      error: error.message,
      options
    };
  }
}

/**
 * Determine prompt complexity level
 * @param {string} prompt - Prompt text to analyze
 * @returns {string} Complexity level ('simple', 'medium', or 'complex')
 */
function getPromptType(prompt) {
  if (prompt === TEST_PROMPTS.simple) return 'simple';
  if (prompt === TEST_PROMPTS.medium) return 'medium';
  return 'complex';
}

/**
 * Run comprehensive benchmark suite
 * @param {string} host - Base URL of the Ollama host
 * @param {string[]} models - Array of models to benchmark
 * @param {string} hostName - Name of the host being benchmarked
 * @returns {Object[]} Array of benchmark results
 */
async function runBenchmarkSuite(host, models, hostName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`BENCHMARKING: ${hostName} (${host})`);
  console.log(`${'='.repeat(60)}\n`);

  const results = [];

  for (const model of models) {
    console.log(`\n--- Model: ${model} ---\n`);

    // Test each prompt complexity
    for (const [promptName, prompt] of Object.entries(TEST_PROMPTS)) {
      process.stdout.write(`  ${promptName}: `);
      const result = await runBenchmark(host, model, prompt);

      if (result.success) {
        console.log(`${result.tokensPerSecond} tok/s (${result.outputTokens} tokens in ${result.evalDuration.toFixed(2)}s)`);
      } else {
        console.log(`FAILED - ${result.error}`);
      }

      results.push(result);
    }
  }

  return results;
}

/**
 * Test different GPU layer configurations
 * @param {string} host - Base URL of the Ollama host
 * @param {string} model - Model name to test
 * @param {number[]} layerConfigs - Array of GPU layer configurations to test
 * @returns {Object[]} Array of test results
 */
async function testGpuLayers(host, model, layerConfigs) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`GPU LAYER TEST: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = [];
  const prompt = TEST_PROMPTS.medium;

  for (const numGpu of layerConfigs) {
    process.stdout.write(`  num_gpu=${numGpu}: `);

    const result = await runBenchmark(host, model, prompt, { num_gpu: numGpu });

    if (result.success) {
      console.log(`${result.tokensPerSecond} tok/s`);
    } else {
      console.log(`FAILED - ${result.error}`);
    }

    results.push({ numGpu, ...result });
  }

  // Find optimal
  /**
   * Filter successful results and find the best performing configuration
   * @param {Object[]} results - Array of test results
   * @returns {Object} Best performing result
   */
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    /**
     * Find the best performing result by tokens per second
     * @param {Object} a - First result to compare
     * @param {Object} b - Second result to compare
     * @returns {Object} Best performing result
     */
    const best = successful.reduce((a, b) =>
      parseFloat(a.tokensPerSecond) > parseFloat(b.tokensPerSecond) ? a : b
    );
    console.log(`\n  OPTIMAL: num_gpu=${best.numGpu} (${best.tokensPerSecond} tok/s)`);
  }

  return results;
}

/**
 * Test different context window sizes
 * @param {string} host - Base URL of the Ollama host
 * @param {string} model - Model name to test
 * @param {number[]} contextSizes - Array of context sizes to test
 * @returns {Object[]} Array of test results
 */
async function testContextSizes(host, model, contextSizes) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CONTEXT SIZE TEST: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = [];
  const prompt = TEST_PROMPTS.medium;

  for (const numCtx of contextSizes) {
    process.stdout.write(`  num_ctx=${numCtx}: `);

    const result = await runBenchmark(host, model, prompt, { num_ctx: numCtx });

    if (result.success) {
      console.log(`${result.tokensPerSecond} tok/s (load: ${result.loadDuration.toFixed(2)}s)`);
    } else {
      console.log(`FAILED - ${result.error}`);
    }

    results.push({ numCtx, ...result });
  }

  return results;
}

/**
 * Test concurrent request throughput
 * @param {string} host - Base URL of the Ollama host
 * @param {string} model - Model name to test
 * @param {number[]} concurrencyLevels - Array of concurrency levels to test
 * @returns {Object[]} Array of test results
 */
async function testConcurrency(host, model, concurrencyLevels) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CONCURRENCY TEST: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  const prompt = TEST_PROMPTS.simple;
  const results = [];

  for (const concurrent of concurrencyLevels) {
    process.stdout.write(`  ${concurrent} concurrent: `);

    const startTime = Date.now();
    const promises = Array(concurrent).fill().map(() =>
      runBenchmark(host, model, prompt)
    );

    const batchResults = await Promise.all(promises);
    const endTime = Date.now();

    const successful = batchResults.filter(r => r.success);
    const totalTokens = successful.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalTime = (endTime - startTime) / 1000;
    const aggregateTokPerSec = totalTokens / totalTime;

    console.log(`${aggregateTokPerSec.toFixed(2)} aggregate tok/s (${successful.length}/${concurrent} succeeded)`);

    results.push({
      concurrent,
      aggregateTokPerSec,
      successRate: successful.length / concurrent,
      totalTime
    });
  }

  return results;
}

/**
 * Generate summary report
 * @param {Object} allResults - Benchmark results object containing modelBenchmarks, gpuLayerTests, contextTests, concurrencyTests
 * @returns {void}
 */
function generateReport(allResults) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('BENCHMARK SUMMARY REPORT');
  console.log(`${'='.repeat(60)}\n`);

  // Model performance ranking
  const modelStats = {};
  for (const result of allResults.modelBenchmarks || []) {
    if (!result.success) continue;
    if (!modelStats[result.model]) {
      modelStats[result.model] = { total: 0, count: 0 };
    }
    modelStats[result.model].total += parseFloat(result.tokensPerSecond);
    modelStats[result.model].count++;
  }

  console.log('Model Performance (avg tok/s):');
  const ranked = Object.entries(modelStats)
    .map(([model, stats]) => ({ model, avg: stats.total / stats.count }))
    .sort((a, b) => b.avg - a.avg);

  ranked.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.model}: ${m.avg.toFixed(2)} tok/s`);
  });

  // Optimal settings
  if (allResults.gpuLayerTests?.length > 0) {
    const best = allResults.gpuLayerTests
      .filter(r => r.success)
      .reduce((a, b) => parseFloat(a.tokensPerSecond) > parseFloat(b.tokensPerSecond) ? a : b);
    console.log(`\nOptimal GPU Layers: ${best.numGpu}`);
  }

  if (allResults.contextTests?.length > 0) {
    const best = allResults.contextTests
      .filter(r => r.success)
      .reduce((a, b) => parseFloat(a.tokensPerSecond) > parseFloat(b.tokensPerSecond) ? a : b);
    console.log(`Optimal Context Size: ${best.numCtx}`);
  }

  return allResults;
}

/**
 * Parse command line arguments
 */
/**
 * Parse command line arguments
 * @param {string[]} args - Array of command line arguments
 * @returns {Object} Parsed arguments object with host, model, test configurations, etc.
 */
function parseArgs(args) {
  const parsed = {
    host: null,
    hostId: null,
    models: null,
    runFull: args.includes('--full'),
    runGpu: args.includes('--gpu'),
    runCtx: args.includes('--context'),
    runConcurrent: args.includes('--concurrent'),
    outputJson: args.includes('--json'),
    listHosts: args.includes('--list-hosts'),
    model: null,
    gpuLayers: null,
    contextSizes: null
  };

  // Parse --host=URL or --host-id=ID
  for (const arg of args) {
    if (arg.startsWith('--host=')) {
      parsed.host = arg.slice(7);
    } else if (arg.startsWith('--host-id=')) {
      parsed.hostId = arg.slice(10);
    } else if (arg.startsWith('--model=')) {
      parsed.model = arg.slice(8);
    } else if (arg.startsWith('--gpu-layers=')) {
      parsed.gpuLayers = arg.slice(13).split(',').map(Number);
    } else if (arg.startsWith('--context-sizes=')) {
      parsed.contextSizes = arg.slice(16).split(',').map(Number);
    }
  }

  // Full suite enables all tests
  if (parsed.runFull) {
    parsed.runGpu = true;
    parsed.runCtx = true;
    parsed.runConcurrent = true;
  }

  return parsed;
}

/**
 * Main benchmark runner
 */
async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  // List available hosts
  if (parsed.listHosts) {
    console.log('TORQUE Configured Ollama Hosts:\n');
    const hosts = getConfiguredHosts();
    if (hosts.length === 0) {
      console.log('No hosts configured in TORQUE database.');
      console.log('Use --host=<url> to specify a host directly.');
    } else {
      for (const host of hosts) {
        console.log(`  ${host.id}: ${host.name}`);
        console.log(`    URL: ${host.url}`);
        console.log(`    Status: ${host.status}`);
        if (host.models_cache) {
          const models = JSON.parse(host.models_cache);
          // Extract model names from objects (format from /api/tags)
          const modelNames = models.map(m => typeof m === 'string' ? m : m.name || m.model || String(m));
          console.log(`    Models: ${modelNames.slice(0, 5).join(', ')}${modelNames.length > 5 ? '...' : ''}`);
        }
        console.log();
      }
    }
    return;
  }

  // Resolve target host
  let targetHost, hostName;

  if (parsed.host) {
    // Direct URL specified
    targetHost = parsed.host;
    hostName = parsed.host;
  } else if (parsed.hostId) {
    // Look up host by ID from TORQUE
    const hosts = getConfiguredHosts();
    const found = hosts.find(h => h.id === parsed.hostId || h.name.toLowerCase() === parsed.hostId.toLowerCase());
    if (!found) {
      console.error(`Host "${parsed.hostId}" not found. Use --list-hosts to see available hosts.`);
      process.exit(1);
    }
    targetHost = found.url;
    hostName = found.name;
  } else {
    // Auto-detect: use first available host from TORQUE
    const hosts = getConfiguredHosts();
    if (hosts.length > 0) {
      // Prefer desktop/powerful hosts
      const desktopHost = hosts.find(h =>
        h.name.toLowerCase().includes('desktop') ||
        h.name.toLowerCase().includes('workstation')
      );
      const selected = desktopHost || hosts[0];
      targetHost = selected.url;
      hostName = selected.name;
    } else {
      // Fallback to localhost
      targetHost = 'http://localhost:11434';
      hostName = 'localhost';
    }
  }

  // Get models from host
  let targetModels;
  if (parsed.model) {
    targetModels = [parsed.model];
  } else {
    targetModels = await getHostModels(targetHost);
    if (targetModels.length === 0) {
      console.error(`No models found on ${targetHost}. Is Ollama running?`);
      process.exit(1);
    }
    // Filter to main models (exclude embedding models)
    targetModels = targetModels.filter(m =>
      !m.includes('embed') && !m.includes('nomic')
    );
  }

  console.log('TORQUE Performance Benchmark');
  console.log(`Target: ${hostName} (${targetHost})`);
  console.log(`Models: ${targetModels.join(', ')}`);
  console.log(`Tests: ${parsed.runFull ? 'Full Suite' : (parsed.runGpu || parsed.runCtx || parsed.runConcurrent) ? 'Selected' : 'Basic'}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const allResults = {
    host: targetHost,
    hostName,
    timestamp: new Date().toISOString()
  };

  // Basic model benchmarks
  allResults.modelBenchmarks = await runBenchmarkSuite(targetHost, targetModels, hostName);

  // GPU layer tests
  if (parsed.runGpu && targetModels.length > 0) {
    // Find largest model for GPU testing
    const largeModel = targetModels.find(m => m.includes('32b') || m.includes('34b')) ||
                       targetModels.find(m => m.includes('22b') || m.includes('16b')) ||
                       targetModels[0];

    const gpuLayers = parsed.gpuLayers || [-1, 40, 50, 60, 70, 80, 99];
    allResults.gpuLayerTests = await testGpuLayers(targetHost, largeModel, gpuLayers);
  }

  // Context size tests
  if (parsed.runCtx && targetModels.length > 0) {
    const contextSizes = parsed.contextSizes || [4096, 8192, 16384, 32768];
    allResults.contextTests = await testContextSizes(targetHost, targetModels[0], contextSizes);
  }

  // Concurrency tests
  if (parsed.runConcurrent && targetModels.length > 0) {
    // Use smallest/fastest model for concurrency tests
    const smallModel = targetModels.find(m => m.includes('mini') || m.includes(':7b') || m.includes('phi3')) ||
                       targetModels[targetModels.length - 1];
    allResults.concurrencyTests = await testConcurrency(targetHost, smallModel, [1, 2, 3, 4]);
  }

  // Generate report
  generateReport(allResults);

  // Output JSON for programmatic use
  if (parsed.outputJson) {
    console.log('\n--- JSON Results ---');
    console.log(JSON.stringify(allResults, null, 2));
  }

  return allResults;
}

// Export for use as module
module.exports = {
  runBenchmark,
  runBenchmarkSuite,
  testGpuLayers,
  testContextSizes,
  testConcurrency,
  getConfiguredHosts,
  getHostModels,
  TEST_PROMPTS
};

// Help text
/**
 * Display help information for benchmark tool usage
 */
function showHelp() {
  console.log(`
TORQUE Performance Benchmark Tool

Usage: node benchmark.js [options]

Options:
  --list-hosts          List configured TORQUE Ollama hosts
  --host=<url>          Benchmark specific host by URL
  --host-id=<id>        Benchmark specific host by TORQUE ID
  --model=<name>        Benchmark specific model only
  --gpu                 Run GPU layer optimization tests
  --context             Run context window size tests
  --concurrent          Run concurrency tests
  --full                Run all tests (gpu + context + concurrent)
  --gpu-layers=N,N,...  Custom GPU layer values to test
  --context-sizes=N,N   Custom context sizes to test
  --json                Output results as JSON
  --help                Show this help

Examples:
  node benchmark.js --list-hosts
  node benchmark.js --host-id=desktop-17
  node benchmark.js --host=http://192.168.1.100:11434 --full
  node benchmark.js --model=qwen2.5-coder:32b --gpu --gpu-layers=-1,60,80,99
`);
}

// Run if called directly
if (require.main === module) {
  if (process.argv.includes('--help')) {
    showHelp();
  } else {
    main().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
