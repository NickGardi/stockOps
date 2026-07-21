# StockOps

Embedded Shopify app for inventory replenishment: reorder suggestions from sales, suppliers, purchase orders, receiving, transfers, stock takes, and adjustments — synced with Shopify inventory.

**Live app:** https://stockops-nickgardi.fly.dev  
**Privacy:** https://stockops-nickgardi.fly.dev/privacy.html  
**Terms:** https://stockops-nickgardi.fly.dev/terms.html

## Features

- Reorder suggestions from sales velocity and warehouse stock
- Suppliers with cost and lead time per variant
- Purchase orders with receiving into Shopify inventory
- Transfers between locations
- Stock takes and adjustments
- Dashboard for low stock / stockout risk
- GDPR compliance webhooks
- Shopify Billing ($10/mo after 30-day trial)

## Stack

- Remix + Shopify App Remix + Polaris + App Bridge
- Prisma + PostgreSQL
- Hosted on Fly.io

## Local development

**Requirements:** Node 22+, Shopify CLI, Docker (for local Postgres)

```bash
cp .env.example .env
# Fill SHOPIFY_API_KEY, SHOPIFY_API_SECRET, ENCRYPTION_KEY (openssl rand -hex 32)

docker compose up -d          # local Postgres
npm install
npx prisma migrate deploy
shopify app dev
```

## Production (Fly.io)

```bash
fly secrets set \
  SHOPIFY_API_KEY=... \
  SHOPIFY_API_SECRET=... \
  SCOPES=write_products,read_inventory,write_inventory,read_orders,read_locations,write_locations \
  SHOPIFY_APP_URL=https://stockops-nickgardi.fly.dev \
  ENCRYPTION_KEY=... \
  NODE_ENV=production

fly deploy
```

`DATABASE_URL` is set by `fly postgres attach`. Migrations run on boot via `npm run setup`.

## Scripts

| Command | Purpose |
|---------|---------|
| `shopify app dev` | Local embedded app + tunnel |
| `npm run build` | Production build |
| `npm run test` | Unit tests |
| `npm run seed-demo-sales -- --shop=YOUR-STORE.myshopify.com` | Demo sales for reorder testing |
| `fly deploy` | Deploy to Fly |

## License

Proprietary — StockOps. Not affiliated with Shopify.
