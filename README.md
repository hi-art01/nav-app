# Helm Marine Navigation

Static boat navigation website with satellite map, GPS tracking, destinations, saved routes, fish/lobster markers, and depth notes.

## Run locally

```powershell
npm install
npm run dev
```

All navigation data is saved in the browser with `localStorage`, so this version works on GitHub Pages without a server or login database.

## Publish on GitHub Pages

1. Push this repository to GitHub using the `main` branch.
2. In the repository, open **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push a change or run **Deploy Helm to GitHub Pages** from the Actions tab.

The workflow in `.github/workflows/deploy-pages.yml` builds and publishes `dist` automatically.
