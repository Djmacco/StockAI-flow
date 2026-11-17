# StockFlow AI web app

Vercel-ready StockFlow AI browser app. A cloud administrator can open **Company sales** to view synced transactions and live inventory, including all products, stock received/removed, and a paginated movement ledger. The monitor refreshes every 30 seconds; data appears only after a shop computer uploads it to StockFlow Cloud. Receipts and filtered reports can be printed or saved as PDF.

The site is installable as a PWA on supported phones. On mobile, use the bottom navigation to reach Dashboard, Products, Movements, Reports, and Company sales. The service worker caches only the app shell/static assets; account and company data are never cached, and live cloud views require internet access. The browser app remains read-only for stock and sales because the desktop-to-cloud relay is one way.

The live inventory view requires the backend `GET /company/inventory` endpoint. Deploy the matching backend before deploying the website update.

Start with [the Vercel deployment guide](../docs/WEB_DEPLOYMENT.md). Use a distinct browser device identity; never copy the desktop device ID.
# StockAI-flow
