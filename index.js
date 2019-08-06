const IO = require('socket.io');
const ioClient = require('socket.io-client');
const {IApiServer, IApiClient} = require('osmium-iapi');
const parser = require('osmium-socket.io-parser');
const {IApiECDHAuthProvider} = require('@osmium/iapi-ecdh');
const oTools = require('osmium-tools');

class IApiInterConnect {
	constructor(server, interconnects = {}, clients = {}) {
		this.serverOpt = Object.assign({
			port      : 9001,
			name      : 'server',
			privateKey: '',
			keySalt   : 'aOXrGs56cA0w'
		}, server, {});
		this.serverName = this.serverOpt.name;

		this.interconnects = interconnects;
		this.clients = clients;

		this.inited = false;
	}

	async _initLocalServer() {
		oTools.iterate(this.interconnects, (ic, name) => this.clients[name] = ic.publicKey);

		const io = IO(this.serverOpt.port, {parser});
		this.server = new IApiServer(io, {keySalt: this.serverOpt.keySalt}, this.serverName, new IApiECDHAuthProvider(this.serverOpt.privateKey, this.clients));
	}

	async _startOutgoingConnects() {
		this.apis = await oTools.iterate(this.interconnects, async (ic, name, iter) => {
			const ioIApiSocket = ioClient.connect(`http://${ic.host}:${ic.port}`, {parser, forceNew: true});
			const iApi = new IApiClient(ioIApiSocket, {keySalt: this.serverOpt.keySalt}, this.serverName, new IApiECDHAuthProvider(this.serverOpt.privateKey, this.clients));
			console.log(`Connect to ${name}`);
			await iApi.ready();

			iApi.registerMiddlewareOutBefore((packet, socket, before) => {
				if (!packet || !packet.args || !packet.args[0] || !before) return packet;
				if (oTools.isObject(packet.args[0])) Object.assign(packet.metadata, packet.args[0]);
				packet.args.splice(0, 1);
				return packet;
			});

			iter.key(name);
			return iApi;
		}, {});
	}

	async _startProxyOut() {
		this.server.registerMiddlewareInc((packet, socket, before) => {
			if (!packet || !before || this.server.exists(packet.name, false)) return packet;
			const eventName = this.getEventName(packet.name);

			if (this.isMe(packet.name)) {
				packet.name = eventName;
				return packet;
			}
			const targetName = this.getTargetName(packet.name);

			if (!this.apis[targetName]) return null;
			this.apis[targetName].emit(eventName, [packet.metadata, ...packet.args]);
		});
	}

	async init() {
		if (this.inited) return;

		await this._initLocalServer();
		await this._startOutgoingConnects();
		await this._startProxyOut();

		this.inited = true;
	}

	getTargetName(packetName) {
		const match = packetName.match(/@([a-z]+) .*/);
		return match && match[1] ? match[1] : false;
	}

	getEventName(packetName) {
		return packetName.replace(/(@[a-z]+) .*/, (match, p1) => match.substr(p1.length)).trim();
	}

	isMe(packetName) {
		return this.getTargetName(packetName) === this.serverName;
	}
}

module.exports = {IApiInterConnect};
