// noVNC를 한 파일(IIFE)로 묶음. 최상위 await 한 줄만 Promise로 바꿔서 처리
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
esbuild.build({
  entryPoints: [path.join(__dirname, 'novnc-entry.js')],
  bundle: true, format: 'iife', minify: true, target: 'chrome120',
  outfile: path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'novnc.js'),
  legalComments: 'eof',
  banner: { js: `/*! noVNC ${JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', '@novnc', 'novnc', 'package.json'), 'utf8')).version} | Copyright (C) The noVNC authors | MPL-2.0 (https://mozilla.org/MPL/2.0/) | 원본 소스: https://github.com/novnc/noVNC , 수정한 소스와 변경 내역: OiTerm 배포 폴더의 third_party/noVNC | pako: MIT (C) Vitaly Puzrin, Andrei Tuputcyn */` },
  plugins: [{
    name: 'no-tla',
    setup(b) {
      b.onLoad({ filter: /core[\\/]util[\\/]browser\.js$/ }, (args) => {
        let src = fs.readFileSync(args.path, 'utf8');
        src = src.replace(/supportsWebCodecsH264Decode = await (_checkWebCodecsH264DecodeSupport\(\));/,
          '$1.then((v) => { supportsWebCodecsH264Decode = v; });');
        return { contents: src, loader: 'js' };
      });
    },
  }],
}).then(() => console.log('novnc bundled')).catch((e) => { console.error(e.message); process.exit(1); });
