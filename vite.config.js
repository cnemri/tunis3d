import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

// The client lives in web/, generated data in data/ (served at /data).
export default defineConfig({
  root: 'web',
  publicDir: false,
  server: {
    port: 5180,
    fs: { allow: [path.resolve(__dirname)] },
  },
  preview: {
    port: 5180,
  },
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [
    {
      name: 'serve-data',
      configureServer(server) {
        server.middlewares.use('/data', (req, res, next) => {
          const file = path.join(__dirname, 'data', decodeURIComponent(req.url.split('?')[0]));
          fs.stat(file, (err, st) => {
            if (err || !st.isFile()) return next();
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(file).pipe(res);
          });
        });
      },
      closeBundle() {
        const distData = path.resolve(__dirname, 'dist', 'data');
        const srcData = path.resolve(__dirname, 'data');
        if (!fs.existsSync(distData)) {
          fs.mkdirSync(distData, { recursive: true });
        }
        const landmarksSrc = path.join(srcData, 'landmarks.json');
        if (fs.existsSync(landmarksSrc)) {
          fs.copyFileSync(landmarksSrc, path.join(distData, 'landmarks.json'));
        }
        const tilesSrc = path.join(srcData, 'tiles');
        const tilesDist = path.join(distData, 'tiles');
        if (fs.existsSync(tilesSrc)) {
          fs.cpSync(tilesSrc, tilesDist, { recursive: true });
        }
      },
    },
  ],
});

