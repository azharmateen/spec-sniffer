#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { crawl, CrawlOptions } from './crawler';
import { buildEndpoints } from './schema-builder';
import { generateOpenAPISpec, specToYAML, specToJSON } from './openapi-generator';
import { enrichEndpoints } from './ai-enricher';

const program = new Command();

program
  .name('spec-sniffer')
  .description('Reverse-engineer API documentation by crawling a web app with a headless browser')
  .version('1.0.0')
  .argument('<url>', 'Base URL of the web application to crawl')
  .option('-o, --output <file>', 'Output file path (default: api-spec.yaml)')
  .option('-f, --format <format>', 'Output format: yaml or json', 'yaml')
  .option('--max-pages <n>', 'Maximum pages to crawl', '50')
  .option('--max-depth <n>', 'Maximum link depth', '3')
  .option('--timeout <ms>', 'Page load timeout in milliseconds', '30000')
  .option('--no-headless', 'Show browser window during crawl')
  .option('--no-forms', 'Skip filling and submitting forms')
  .option('--no-buttons', 'Skip clicking buttons')
  .option('--enrich', 'Use AI to generate endpoint descriptions (requires OPENAI_API_KEY)')
  .option('--model <model>', 'AI model for enrichment', 'gpt-4o-mini')
  .option('-v, --verbose', 'Verbose output')
  .action(async (url: string, options) => {
    const startTime = Date.now();

    console.log(chalk.bold.cyan('\n  spec-sniffer'));
    console.log(chalk.gray(`  Target: ${url}\n`));

    // Validate URL
    try {
      new URL(url);
    } catch {
      console.error(chalk.red(`Invalid URL: ${url}`));
      process.exit(1);
    }

    // Crawl
    console.log(chalk.yellow('Phase 1: Crawling web application...'));

    const crawlOptions: CrawlOptions = {
      baseUrl: url,
      maxPages: parseInt(options.maxPages, 10),
      maxDepth: parseInt(options.maxDepth, 10),
      timeout: parseInt(options.timeout, 10),
      waitForIdle: 2000,
      headless: options.headless !== false,
      fillForms: options.forms !== false,
      clickButtons: options.buttons !== false,
      verbose: options.verbose || false,
    };

    const crawlResult = await crawl(crawlOptions);

    console.log(chalk.green(`  Visited ${crawlResult.pagesVisited.length} pages`));
    console.log(chalk.green(`  Captured ${crawlResult.requests.length} network requests`));

    if (crawlResult.errors.length > 0) {
      console.log(chalk.yellow(`  ${crawlResult.errors.length} errors encountered`));
      if (options.verbose) {
        crawlResult.errors.forEach((e) => console.log(chalk.gray(`    ${e}`)));
      }
    }

    // Filter to API requests
    const apiRequests = crawlResult.requests.filter((r) => {
      const ct = r.contentType.toLowerCase();
      return (
        ct.includes('json') ||
        ct.includes('xml') ||
        ct.includes('form') ||
        r.requestBody !== null
      );
    });

    console.log(chalk.green(`  Found ${apiRequests.length} API requests`));

    if (apiRequests.length === 0) {
      console.log(chalk.yellow('\nNo API requests detected. The application might:'));
      console.log(chalk.yellow('  - Use server-side rendering'));
      console.log(chalk.yellow('  - Require authentication'));
      console.log(chalk.yellow('  - Not make any XHR/fetch calls on the crawled pages'));
      console.log(chalk.yellow('\nTry: --no-headless to see the browser, -v for verbose output'));
      process.exit(0);
    }

    // Build schemas
    console.log(chalk.yellow('\nPhase 2: Analyzing endpoints and building schemas...'));

    const endpoints = buildEndpoints(apiRequests);
    console.log(chalk.green(`  Discovered ${endpoints.size} unique endpoints`));

    if (options.verbose) {
      for (const [key] of endpoints) {
        console.log(chalk.gray(`    ${key}`));
      }
    }

    // Optional AI enrichment
    let descriptions: Map<string, string> | undefined;

    if (options.enrich) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.log(chalk.yellow('\nWarning: OPENAI_API_KEY not set, skipping AI enrichment'));
      } else {
        console.log(chalk.yellow('\nPhase 3: AI enrichment of endpoint descriptions...'));
        try {
          const enrichment = await enrichEndpoints(apiKey, endpoints, options.model);
          descriptions = enrichment.descriptions;
          console.log(chalk.green(`  Generated descriptions for ${descriptions.size} endpoints`));
        } catch (err: any) {
          console.log(chalk.yellow(`  AI enrichment failed: ${err.message}`));
        }
      }
    }

    // Generate OpenAPI spec
    console.log(chalk.yellow(`\n${options.enrich ? 'Phase 4' : 'Phase 3'}: Generating OpenAPI specification...`));

    const spec = generateOpenAPISpec(endpoints, url, undefined, descriptions);

    const format = options.format || 'yaml';
    const output = format === 'json' ? specToJSON(spec) : specToYAML(spec);

    // Determine output path
    const defaultExt = format === 'json' ? 'json' : 'yaml';
    const outputPath = options.output || `api-spec.${defaultExt}`;
    const absPath = path.resolve(outputPath);

    fs.writeFileSync(absPath, output, 'utf-8');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(chalk.bold.green(`\n  Done in ${elapsed}s`));
    console.log(chalk.white(`  Spec written to: ${absPath}`));
    console.log(chalk.white(`  Endpoints: ${endpoints.size}`));
    console.log(chalk.white(`  Pages crawled: ${crawlResult.pagesVisited.length}`));
    console.log(chalk.white(`  API calls captured: ${apiRequests.length}`));
    console.log('');
  });

program.parse();
