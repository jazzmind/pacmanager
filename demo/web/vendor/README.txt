Vendored browser builds (no build step, no npm deps in package.json):
  marked     18.1.0   lib/marked.umd.js  (renamed marked.min.js)  MIT   see LICENSE-marked.txt
  dompurify  3.4.16   dist/purify.min.js                          Apache-2.0 OR MPL-2.0  see LICENSE-purify.txt
Obtained via `npm pack marked dompurify` in a scratch directory. sourceMappingURL comments stripped (only change).
  codemirror (bundle) 6.0.2  codemirror.min.js  MIT  see LICENSE-codemirror.txt
    Built ONCE in a scratch dir outside the repo: npm i codemirror @codemirror/{state,view,commands,language,lang-html,lang-css,lang-javascript,lang-json,lang-markdown,lang-python,legacy-modes,theme-one-dark} esbuild;
    esbuild entry.js --bundle --minify --format=iife --global-name=PacCM --legal-comments=none (no sourceMappingURL). Exposes window.PacCM {createEditor,setDoc,getDoc,destroy}.
    The editor mounts inside a shadow root so style-mod uses constructable stylesheets (adoptedStyleSheets), never <style> elements (CSP style-src 'self'); createEditor throws if that is unavailable and code-ui.js falls back to a <textarea>.
    codemirror 6.0.2
    @codemirror/state 6.7.6
    @codemirror/view 6.43.14
    @codemirror/commands 6.11.1
    @codemirror/language 6.13.1
    @codemirror/lang-html 6.4.12
    @codemirror/lang-css 6.3.1
    @codemirror/lang-javascript 6.2.5
    @codemirror/lang-json 6.0.2
    @codemirror/lang-markdown 6.5.2
    @codemirror/lang-python 6.2.1
    @codemirror/legacy-modes 6.5.5
    @codemirror/theme-one-dark 6.1.3
    style-mod 4.1.4
    crelt 1.0.7
    w3c-keyname 2.2.8
    @lezer/common 1.5.3
    @lezer/highlight 1.2.5
    @lezer/lr 1.4.11
    @lezer/html 1.3.13
    @lezer/css 1.3.9
    @lezer/javascript 1.5.6
    @lezer/json 1.0.3
    @lezer/markdown 1.8.0
    @lezer/python 1.1.19
    esbuild 0.28.2
