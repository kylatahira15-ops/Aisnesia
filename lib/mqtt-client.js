"use strict";

const mqtt = require('mqtt');

const HOST   = process.env.MQTT_HOST || 'localhost';
const PORT   = parseInt(process.env.MQTT_PORT) || 1883;
const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'ais';

const BROKER = `mqtt://${HOST}:${PORT}`;
const TOPIC_LINE  = `${PREFIX}/actuator/line`;
const TOPIC_STATE = `${PREFIX}/actuator/state`;

let client = null;
let connected = false;
let pendingMessages = [];

function connect() {
  client = mqtt.connect(BROKER, {
    clientId: `aisnesia_${Math.random().toString(36).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 3000,
  });

  client.on('connect', () => {
    connected = true;
    console.log(`[MQTT] Terhubung ke ${BROKER}`);
    const pending = pendingMessages.splice(0);
    for (const { topic, payload } of pending) {
      client.publish(topic, payload, { qos: 0 });
    }
  });

  client.on('close', () => {
    connected = false;
  });

  client.on('error', (err) => {
    console.error(`[MQTT] Error: ${err.message}`);
  });

  client.on('offline', () => {
    connected = false;
  });
}

function publish(topic, payload) {
  if (client && connected) {
    client.publish(topic, payload, { qos: 0 });
  } else {
    pendingMessages.push({ topic, payload });
  }
}

function publishLine(line) {
  publish(TOPIC_LINE, line);
}

function publishState(stateObj) {
  publish(TOPIC_STATE, JSON.stringify(stateObj));
}

function isConnected() {
  return connected;
}

function getTopics() {
  return { line: TOPIC_LINE, state: TOPIC_STATE };
}

connect();

module.exports = { publish, publishLine, publishState, isConnected, getTopics };
