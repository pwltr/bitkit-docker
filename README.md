# Synonym Docker - Bitcoin & Lightning Development Environment

A complete Docker-based development environment for Bitcoin and Lightning Network development, featuring a LNURL server for Lightning payments.

## Services

- **Bitcoin Core** (regtest): Bitcoin node for development
- **LND**: Lightning Network Daemon for Lightning payments
- **Electrum Server**: For Bitcoin blockchain queries
- **LNURL Server**: Lightning payment server with LNURL support
- **LDK Backup Server**: Lightning Development Kit backup service

## Quick Start

1. **Clone and start the services:**
   ```bash
   git clone <repository-url>
   cd synonym-docker
   docker-compose up -d
   ```

2. **Wait for services to initialize** (about 30-60 seconds)

3. **Check health:**
   ```bash
   curl http://localhost:3000/health
   ```

## Services Overview

### Bitcoin Core
- **Port**: 43782 (RPC), 39388 (P2P)
- **Network**: Regtest
- **Wallet**: Auto-created
- **Authentication**: `polaruser`/`polarpass`

### LND (Lightning Network Daemon)
- **REST API**: `http://localhost:8080`
- **P2P**: `localhost:9735`
- **RPC**: `localhost:10009`
- **Network**: Regtest
- **Features**: Zero-conf, SCID alias, AMP support

### LNURL Server
- **Port**: 3000
- **Features**: 
  - LNURL-withdraw
  - LNURL-pay
  - Lightning Address support
  - QR code generation
- **Endpoints**:
  - `/health` - Service health check
  - `/generate/withdraw` - Generate LNURL-withdraw
  - `/generate/pay` - Generate LNURL-pay
  - `/.well-known/lnurlp/:username` - Lightning Address

### Electrum Server
- **Port**: 60001
- **Network**: Regtest
- **Features**: Full blockchain indexing

## API Examples

### Generate LNURL-withdraw
```bash
curl http://localhost:3000/generate/withdraw
```

### Generate LNURL-pay
```bash
curl http://localhost:3000/generate/pay
```

### Check Health
```bash
curl http://localhost:3000/health | jq
```

### Lightning Address
```bash
curl http://localhost:3000/.well-known/lnurlp/alice
```

## Development

### Adding Blocks (for testing)
```bash
docker-compose exec bitcoind bitcoin-cli -rpcconnect=127.0.0.1 -rpcport=43782 -rpcuser=polaruser -rpcpassword=polarpass generate 1
```

### LND CLI
```bash
docker-compose exec lnd lncli --network=regtest getinfo
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f lnurl-server
docker-compose logs -f lnd
docker-compose logs -f bitcoind
```

## Configuration

### Environment Variables
Key environment variables in `docker-compose.yml`:

- `BITCOIN_RPC_HOST`: Bitcoin RPC host (default: `bitcoind`)
- `BITCOIN_RPC_PORT`: Bitcoin RPC port (default: `43782`)
- `LND_REST_HOST`: LND REST API host (default: `lnd`)
- `LND_REST_PORT`: LND REST API port (default: `8080`)

### Volumes
- `./lnd:/lnd-certs:ro` - LND certificates and macaroons
- `./lnurl-server/data:/data` - LNURL server database
- `bitcoin_home` - Bitcoin blockchain data

## Troubleshooting

### Services not starting
1. Check if ports are available
2. Ensure Docker has enough resources
3. Check logs: `docker-compose logs`

### LNURL server not connecting to LND
1. Wait for LND to fully sync
2. Check macaroon files exist
3. Verify network connectivity between containers

### Bitcoin RPC issues
1. Ensure Bitcoin Core is fully synced
2. Check RPC authentication credentials
3. Verify port mappings

## Security Notes

- This setup uses **regtest** network for development
- Self-signed certificates are used for LND REST API
- Default credentials are used (change for production)
- All services are exposed on localhost only

## Production Considerations

For production deployment:
1. Use mainnet/testnet instead of regtest
2. Change default passwords and credentials
3. Use proper SSL certificates
4. Implement proper backup strategies
5. Add monitoring and logging
6. Use secrets management for sensitive data

## License

[Add your license here] 