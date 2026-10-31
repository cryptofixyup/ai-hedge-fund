import { createGatewayServer } from './gateway.mjs';

const server = createGatewayServer();
const port = Number.parseInt(process.env.PORT || '3000', 10);

server.listen(port, '0.0.0.0');
