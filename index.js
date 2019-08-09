const Events = require('osmium-events');
const IO = require('socket.io');
const ioClient = require('socket.io-client');
const {IApiServer, IApiClient} = require('osmium-iapi');
const parser = require('osmium-socket.io-parser');
const {IApiECDHAuthProvider} = require('@osmium/iapi-ecdh');
const oTools = require('osmium-tools');

class IApiInterConnect extends Events {
	constructor(server, interconnects = {}, clients = {}) {
		super();

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
		this.remoteNameChar = '@';
		this.events = {
			INIT_START                       : 'init start',
			LOCAL_SERVER_START               : 'local server start',
			OUTGOING_CONNECT_START           : 'outgoing connect start',
			OUTGOING_CONNECTED               : 'outgoing connected',
			OUTGOING_DISCONNECTED            : 'outgoing disconnected',
			PROXY_START                      : 'proxy start',
			LOCAL_MESSAGE                    : 'local message',
			INTERCONNECT_MESSAGE             : 'interconnect message',
			INTERCONNECT_MESSAGE_UNKNOWN_RCPT: 'interconnect message unknown rcpt'
		};

		this.on(this.events.OUTGOING_CONNECTED, (_, __, name) => console.log(`Connect ${this.serverName} to ${name} IS OK`));
	}

	async _initLocalServer() {
		oTools.iterate(this.interconnects, (ic, name) => this.clients[name] = ic.publicKey);

		const io = IO(this.serverOpt.port, {parser});
		this.server = new IApiServer(io, {keySalt: this.serverOpt.keySalt}, this.serverName, new IApiECDHAuthProvider(this.serverOpt.privateKey, this.clients));
		await this.emit(this.events.LOCAL_SERVER_START, this.server, io, this.serverName, this);
	}

	async _startOutgoingConnects() {
		this.apis = {};
		oTools.iterateParallel(this.interconnects, async (ic, name) => {
			const _connect = async () => {
				if (name === this.serverName) return;
				const ioIApiSocket = ioClient.connect(`http://${ic.host}:${ic.port}`, {parser, forceNew: true});
				const iApi = new IApiClient(ioIApiSocket, {keySalt: this.serverOpt.keySalt}, this.serverName, new IApiECDHAuthProvider(this.serverOpt.privateKey, this.clients));
				await this.emit(this.events.OUTGOING_CONNECT_START, iApi, ioIApiSocket, name, this);

				await iApi.ready();

				iApi.registerMiddlewareOutBefore((packet, socket, before) => {
					if (!packet || !packet.args || !packet.args[0] || !before) return packet;
					if (oTools.isObject(packet.args[0])) Object.assign(packet.metadata, packet.args[0]);
					packet.args.splice(0, 1);
					return packet;
				});
				this.apis[name] = iApi;
				await this.emit(this.events.OUTGOING_CONNECTED, iApi, ioIApiSocket, name, this);
				return iApi;
			};

			(await _connect()).onDisconnect(async () => {
				await this.emit(this.events.OUTGOING_DISCONNECTED, name, this);
				delete this.apis[name];
				await _connect();
			});
		});
	}

	async _startProxyOut() {
		await this.emit(this.events.PROXY_START, this);
		this.server.registerMiddlewareInc(async (packet, socket, before) => {
			if (!packet || !before) return packet;

			const eventName = this.getEventName(packet.name);
			if (this.server.exists(packet.name, false)) { // @todo: check logic for local
				if (this.isMe(packet.name)) await this.emit(this.events.LOCAL_MESSAGE, eventName, packet, socket, this);
				return packet;
			}

			if (this.isMe(packet.name)) {
				packet.name = eventName;
				await this.emit(this.events.LOCAL_MESSAGE, eventName, packet, socket, this);
				return packet;
			}
			const targetName = this.getTargetName(packet.name);
			if (!this.apis[targetName]) return null;

			this.server.on(packet.name, async (...args) => {
				if (!this.apis[targetName]) {
					await this.emit(this.events.INTERCONNECT_MESSAGE_UNKNOWN_RCPT, packet.name, targetName, eventName, packet, Object.keys(this.apis));
					return [];
				}

				await this.emit(this.events.INTERCONNECT_MESSAGE, eventName, packet, this.apis[targetName], targetName, this.apis[targetName].socket, socket, this);
				return await this.apis[targetName].emit(eventName, packet.metadata, ...args);
			});
		});
	}

	async init() {
		if (this.inited) return;

		await this.emit(this.events.INIT_START, this);
		await this._initLocalServer();
		await this._startOutgoingConnects();
		await this._startProxyOut();

		this.inited = true;
	}

	getEventName(packetName) {
		return this.getTargetName(packetName) ? packetName.split(' ').splice(1).join(' ') : packetName;
	}

	getTargetName(packetName) {
		const ec = packetName.split(' ')[0];
		return ec[0] === this.remoteNameChar ? ec.substr(1) : false;
	}

	isMe(packetName) {
		let tName = this.getTargetName(packetName);
		return tName ? tName === this.serverName : true;
	}
}

module.exports = {IApiInterConnect};
