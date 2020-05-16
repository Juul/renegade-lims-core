'use strict';

const path = require('path');
const tls = require('tls');

const fs = require('fs-extra');

const multiplex = require('multiplex');
const multifeed = require('multifeed');
const kappa = require('kappa-core');
const view = require('kappa-view');

const sublevel = require('subleveldown');
const backoff = require('backoff');

const tlsUtils = require('./lib/tls.js');

const objectsByGUIDView = require('./views/objectsByGUID.js');
const objectsByBarcodeView = require('./views/objectsByBarcode.js');
const swabTubesByFormBarcodeView = require('./views/swabTubesByFormBarcode.js');
const swabTubesByTimestampView = require('./views/swabTubesByTimestamp.js');
const swabsByTimeView = require('./views/swabsByTimestamp.js');
const swabsByUserView = require('./views/swabsByUsername.js');
const platesByTimestampView = require('./views/platesByTimestamp.js');
const qpcrResultsByTimestampView = require('./views/qpcrResultsByTimestamp.js');
const qpcrResultBySampleBarcodeView = require('./views/qpcrResultBySampleBarcode.js');
const usersByGUIDView = require('./views/usersByGUID.js');
const usersByNameView = require('./views/usersByName.js');

const OBJECTS_BY_GUID = 'og'; // everything by GUID
const OBJECTS_BY_BARCODE = 'ob'; // everything by barcode
const SWAB_TUBES_BY_FORM_BARCODE = 'sfb';
const SWAB_TUBES_BY_TIMESTAMP = 'stt';
const QPCR_RESULTS_BY_TIMESTAMP = 'qrt';
const QPCR_RESULT_BY_SAMPLE_BARCODE = 'qrsb';
const SWABS_BY_TIME = 'st';
const SWABS_BY_USER = 'su';
const PLATES_BY_TIME = 'pt';

const USERS_BY_GUID = 'ug';
const USERS_BY_NAME = 'un';

function init(db, opts, cb) {

  const dataPath = opts.dataPath;
  
  fs.ensureDirSync(dataPath, {
    mode: 0o2750
  });
  
  const multifeedPath = path.join(dataPath, 'lab_feed');
  const labMulti = multifeed(multifeedPath, {valueEncoding: 'json'})
  const labCore = kappa(null, {multifeed: labMulti});

  const multifeedAdminPath = path.join(dataPath, 'admin_feed');
  const adminMulti = multifeed(multifeedAdminPath, {valueEncoding: 'json'})
  const adminCore = kappa(null, {multifeed: adminMulti});
  
  const labDB = sublevel(db, 'l', {valueEncoding: 'json'});
  const adminDB = sublevel(db, 'a', {valueEncoding: 'json'});
  
  labCore.use('objectsByGUID', 1, view(sublevel(labDB, OBJECTS_BY_GUID, {valueEncoding: 'json'}), objectsByGUIDView));
  labCore.use('objectsByBarcode', 1, view(sublevel(labDB, OBJECTS_BY_BARCODE, {valueEncoding: 'json'}), objectsByBarcodeView));
  labCore.use('swabTubesByFormBarcode', 1, view(sublevel(labDB, SWAB_TUBES_BY_FORM_BARCODE, {valueEncoding: 'json'}), swabTubesByFormBarcodeView));
  labCore.use('swabTubesByTimestamp', 1, view(sublevel(labDB, SWAB_TUBES_BY_TIMESTAMP, {valueEncoding: 'json'}), swabTubesByTimestampView));
  labCore.use('swabsByUser', 1, view(sublevel(labDB, SWABS_BY_USER, {valueEncoding: 'json'} ), swabsByUserView));
  labCore.use('platesByTimestamp', 1, view(sublevel(labDB, SWABS_BY_TIME, {valueEncoding: 'json'} ), platesByTimestampView));
  labCore.use('qpcrResultsByTimestamp', 1, view(sublevel(labDB, QPCR_RESULTS_BY_TIMESTAMP, {valueEncoding: 'json'} ), qpcrResultsByTimestampView));
  labCore.use('qpcrResultBySampleBarcode', 1, view(sublevel(labDB, QPCR_RESULT_BY_SAMPLE_BARCODE, {valueEncoding: 'json'} ), qpcrResultBySampleBarcodeView));

  adminCore.use('usersByGUID', 1, view(sublevel(adminDB, USERS_BY_GUID, {valueEncoding: 'json'} ), usersByGUIDView));
  adminCore.use('usersByName', 1, view(sublevel(adminDB, USERS_BY_NAME, {valueEncoding: 'json'} ), usersByNameView));

  const core = {
    labCore,
    adminCore,
    labMulti,
    adminMulti
  };
  
  // Wait for multifeeds to be ready
  // before proceeding with initialization
  labMulti.ready(function() {
    adminMulti.ready(function() {
      
      initPeers(core, opts);
      
      cb(null, core);
    });
  });
}


function beginReplication(peer, socket, core, isInitiator) {

  const peerDesc = {
    type: peer.type,
    host: (peer.connect) ? peer.connect.host : socket.remoteAddress,
    port: socket.remotePort
  }
  
  if(peer.type === 'lab-device') {
    return labDeviceConnection(peer, socket, peerDesc);
  }
  
  var labReadAllowed = false;
  var adminWriteAllowed = false;
  
  if(peer.type === 'field') {

    labReadAllowed = false;
    adminWriteAllowed = false;
    
  } else if(peer.type === 'lab' || peer.type === 'server') {
    
    labReadAllowed = true;
    adminWriteAllowed = true;
    
  } else { // not a recognized certificate for any type of device
    console.log("Connection from unknown peer type with a valid certificate");
    socket.destroy();
    return;
  }

  console.log("peer is of type:", peer.type)
  
  const mux = multiplex();
  const labStream = mux.createSharedStream('labStream');
  const adminStream = mux.createSharedStream('adminStream');

  socket.pipe(mux).pipe(socket);

  labStream.pipe(core.labMulti.replicate(isInitiator, {
    download: true,
    upload: labReadAllowed,
    live: true
  })).pipe(labStream);
  
  adminStream.pipe(core.adminMulti.replicate(isInitiator, {
    download: adminWriteAllowed,
    upload: true,
    live: true
  })).pipe(adminStream);

  return peerDesc;
}


function initInbound(core, opts) {

  const peerCerts = tlsUtils.getPeerCerts(opts.tlsPeers);

  var server = tls.createServer({
    ca: peerCerts,
    key: opts.tlsKey,
    cert: opts.tlsCert,
    requestCert: true,
    rejectUnauthorized: !opts.insecure,
    enableTrace: !!opts.debug
    
  }, function(socket) {
    console.log("Client connection secured");
    
    var peer = tlsUtils.getPeerCertEntry(opts.tlsPeers, socket.getPeerCertificate());
    if(!peer) {
      if(!opts.insecure) {
        console.log("Unknown peer with valid certificate connected");
        socket.destroy();
        return;
      }
      peer = {
        type: 'lab',
        description: "insecure test peer",
      }
    }
    const peerDesc = beginReplication(peer, socket, core, true);

    console.log("Peer connected:", peerDesc);
  });

  server.on('connection', (socket) => {
    console.log("Client connecting from:", socket.remoteAddress);
  });
  
  server.on('clientError', (err, socket) => {
    console.error("Client error:", socket.remoteAddress || "Unknown client host/IP", err);
  });
  
  server.on('tlsClientError', (err, socket) => {
    // TODO
    // We need a way to figure out which client these errors are for but
    // socket.remoteAddress is unset by the time this error is emitted
    console.error("Client failed to authenticate:", socket.authorizationError || "Unknown error type", err);
  });
  
  console.log("Replication server listening on", opts.host+':'+opts.port);
  
  server.listen({
    host: opts.host,
    port: opts.port
  });
}


function connectToPeerOnce(peer, opts, cb) {
  
  console.log("Connecting to peer:", peer.connect.host + ':' + peer.connect.port);
  const socket = tls.connect(peer.connect.port, peer.connect.host, {
    ca: peer.cert, // only trust this cert
    key: opts.tlsKey,
    cert: opts.tlsCert,
    rejectUnauthorized: !opts.insecure,
    enableTrace: !!opts.debug,
    checkServerIdentity: function(host, cert) {
      console.log("Checking cert for:", host);
      const res = tls.checkServerIdentity(host, cert);
      console.log("  result:", (res === undefined) ? "success" : "certificate invalid");
      return res;
    }
  })
  
  socket.on('secureConnect', function() {

    console.log("Connected to peer:", peer.connect.host + ':' + peer.connect.port);

    beginReplication(peer, socket, core, false);
    cb();
  });

  socket.on('close', function() {
    console.log("Disconnected from peer:", peer.connect.host + ':' + peer.connect.port);
    cb(true);
  });
  
  socket.on('error', function(err) {
    console.error(err);
  });
}

function connectToPeer(peer, opts) {
  if(!peer.connect.port || !peer.connect.host) return;

  // Retry with increasing back-off 
  var back = backoff.fibonacci({
    randomisationFactor: 0,
    initialDelay: 3 * 1000, // 3 seconds
    maxDelay: 30 * 1000
  });

  var count = 0;
  function tryConnect() {
    connectToPeerOnce(peer, opts, function(disconnected) {
      if(disconnected) {
        if(count > 0) {
          back.backoff();
          return;
        }
        process.nextTick(tryConnect);
        count++;
      } else {
        count = 0;
        back.reset();
      }
    });
  }
  
  tryConnect();
  
  back.on('backoff', function(number, delay) {
   console.log("Retrying in", Math.round(delay / 1000), "seconds");
  });


  back.on('ready', function(number, delay) {
    tryConnect();
  });
  
}


function initOutbound(opts) {
  if(!opts.tlsPeers) return;
  
  var peer;
  for(peer of opts.tlsPeers) {
    if(!peer.connect) continue;
    connectToPeer(peer, opts);
  }
}


function initPeers(core, opts) {
  if(opts.host) {
    initInbound(core, opts);
  }

  if(!opts.introvert) {
    initOutbound(core, opts);
  } else {
    console.log("Introvert mode enabled. Ignoring settings.tlsPeers");
  }
}


module.exports = {
  init
}
