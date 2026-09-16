'use strict';
/**
 * Publish website/ to the gh-pages branch, i.e. the live site at
 *   https://hobsrkm.github.io/yuvixterm/
 *
 * website/ is written against the future custom domain (https://yuvixterm.app/)
 * with root-relative paths. GitHub Pages serves this repo as a *project* site
 * under /yuvixterm/, so on the way out we:
 *   - rewrite the placeholder domain to the live URL (canonical, OG, JSON-LD,
 *     sitemap, robots),
 *   - turn root-relative href/src into relative ones in the HTML ("/styles.css"
 *     -> "styles.css", "/" -> "./"), except in 404.html, which can be served
 *     from any depth and therefore gets absolute URLs,
 *   - add .nojekyll so Pages serves files (e.g. _headers) verbatim.
 * The result is committed on gh-pages (via a temporary worktree) and pushed.
 *
 * Run with:  npm run site:publish
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'website');
const BRANCH = 'gh-pages';
const SITE_URL = 'https://hobsrkm.github.io/yuvixterm/';
const PLACEHOLDER = 'https://yuvixterm.app/';
const TEXT = new Set(['.html', '.css', '.xml', '.txt', '.svg', '.json', '.js']);

const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

function transform(rel, text) {
  let out = text.replace(/\r\n/g, '\n').split(PLACEHOLDER).join(SITE_URL);
  if (rel === '404.html') {
    out = out.replace(/\b(href|src)="\/([^"/][^"]*|)"/g, (_, attr, p) => `${attr}="${SITE_URL}${p}"`);
  } else if (rel.endsWith('.html')) {
    out = out.replace(/\b(href|src)="\/([^"/][^"]*|)"/g, (_, attr, p) => `${attr}="${p === '' ? './' : p}"`);
  }
  return out;
}

function copyTree(from, to, rel = '') {
  for (const entry of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      fs.mkdirSync(path.join(to, r), { recursive: true });
      copyTree(from, to, r);
    } else if (TEXT.has(path.extname(entry.name))) {
      fs.writeFileSync(path.join(to, r), transform(r, fs.readFileSync(path.join(from, r), 'utf8')));
    } else {
      fs.copyFileSync(path.join(from, r), path.join(to, r));
    }
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvixterm-site-'));
try {
  git(['fetch', '-q', 'origin', BRANCH]);
  git(['worktree', 'add', '-q', '--detach', work, `origin/${BRANCH}`]);
  for (const entry of fs.readdirSync(work)) {
    if (entry !== '.git') fs.rmSync(path.join(work, entry), { recursive: true, force: true });
  }
  copyTree(src, work);
  fs.writeFileSync(path.join(work, '.nojekyll'), '');

  git(['add', '-A'], work);
  if (git(['status', '--porcelain'], work) === '') {
    console.log('site: gh-pages already matches website/ — nothing to publish');
  } else if (process.argv.includes('--dry-run')) {
    console.log(`site: dry run — changes that would be published to ${BRANCH}:\n`);
    console.log(execFileSync('git', ['diff', '--cached', '--stat'], { cwd: work, encoding: 'utf8' }));
    console.log(execFileSync('git', ['diff', '--cached', '--', '404.html', 'robots.txt', 'sitemap.xml'], { cwd: work, encoding: 'utf8' }));
  } else {
    const from = git(['rev-parse', '--short', 'HEAD']);
    git(['commit', '-q', '-m', `site: publish website/ from ${from}`], work);
    git(['push', '-q', 'origin', `HEAD:${BRANCH}`], work);
    console.log(`site: published ${git(['rev-parse', '--short', 'HEAD'], work)} to ${BRANCH} -> ${SITE_URL}`);
  }
} finally {
  try { git(['worktree', 'remove', '--force', work]); } catch { fs.rmSync(work, { recursive: true, force: true }); }
}
