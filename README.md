# OMP Domain Availability

A global [Oh My Pi](https://github.com/can1357/oh-my-pi) custom tool for checking batches of AI-generated domain candidates.

`domain_availability` returns registration status, registration and renewal prices, premium status, promotions, TLD constraints, and direct Namecheap purchase links. It accepts up to 50 candidates per call so agents can generate, check, filter, and rank names in one pass.

## Install

```bash
bun install
mkdir -p ~/.omp/agent/tools
cp index.ts ~/.omp/agent/tools/domain-availability.ts
```

Start a new OMP session after installation. OMP automatically discovers tools in `~/.omp/agent/tools`.

## Agent call

```json
{
  "domains": ["example.com", "unpack.ing", "getexample.dev"]
}
```

The structured result includes:

- `availability`: `available`, `registered`, `unregistered`, or `unknown`
- `source`: `namecheap` or `rdap`
- `registrationPrice`, `regularRegistrationPrice`, and `renewalPrice`
- `priceKind`: `exact-premium` or `standard-tld`
- `premium` and promotion details
- registration-year, IDN, domain-type, and WHOIS privacy metadata
- `namecheapUrl`
- `registrarConfirmationRequired`

## Data modes

### Public mode

Works without credentials:

- Registration status comes from RDAP.
- Standard TLD prices and metadata come from Namecheap's public TLD catalog.
- `unregistered` is intentionally not reported as `available`: registries may reserve names, and premium pricing may apply.
- `priceKind: standard-tld` is an estimate for the extension, not a quote for that exact name.

### Namecheap API mode

Set all four variables:

```bash
export NAMECHEAP_API_USER="..."
export NAMECHEAP_API_KEY="..."
export NAMECHEAP_USERNAME="..."
export NAMECHEAP_CLIENT_IP="..."
```

The tool then uses `namecheap.domains.check`, which confirms Namecheap availability and returns exact premium registration and renewal prices. The client IP must be whitelisted in the Namecheap account. `NAMECHEAP_API_ENDPOINT` can override the production endpoint for sandbox testing.

Never commit credentials. Prefer injecting them through your shell or secret manager. Recheck every finalist immediately before purchase: availability and prices can change at any time.

## Development

```bash
bun install
bun test
bun run check
```

## License

MIT
