# HPC Code Server Stack

## HPC Cluster Access

SSH to clusters (ProxyJump configured in ~/.ssh/config):

```bash
ssh apollo.coh.org
ssh gemini-login1.coh.org
```

Hostnames:
- **Apollo**: `apollo.coh.org`
- **Gemini**: `gemini-login1.coh.org`

## Development

```bash
cd manager
npm install
npm test
npm run test:coverage
```

## Deployment

- **Dev**: Push to `dev` branch, Dokploy auto-deploys via webhook
- **Production**: Use GitHub Actions "Release to Production" workflow
