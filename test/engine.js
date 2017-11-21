const http = require('http');
const express = require('express');
const {graphqlExpress} = require('apollo-server-express');
const bodyParser = require('body-parser');
const {createServer} = require('net');

const {assert} = require('chai');
const isRunning = require('is-running');

const {Engine} = require('../lib/index');

const {schema, rootValue, verifyEndpointSuccess} = require('./schema');
const {startWithDelay, stopWithDelay, testEngine} = require('./test');

describe('engine', () => {
  let app, engine = null;
  beforeEach(() => {
    app = express();
  });
  afterEach(async () => {
    if (engine) {
      if (engine.started) {
        const pid = engine.child.pid;
        await stopWithDelay(engine);
        assert.isFalse(isRunning(pid));
      }
      engine = null;
    }
  });

  function gqlServer(path) {
    path = path || '/graphql';
    app.get(`${path}/ping`, (req, res) => {
      res.json({'pong': true});
    });

    app.use(path, bodyParser.json(), graphqlExpress({
      schema: schema,
      rootValue: rootValue,
      tracing: true
    }));

    return http.createServer(app).listen().address().port;
  }

  function setupEngine(path) {
    engine = testEngine(path);
    app.use(engine.expressMiddleware());

    engine.graphqlPort = gqlServer(path);
  }

  describe('config', () => {
    it('allows reading from file proxy', async () => {
      // Install middleware before GraphQL handler:
      engine = new Engine({
        endpoint: '/graphql',
        engineConfig: 'test/engine.json',
        graphqlPort: 1
      });
      app.use(engine.expressMiddleware());

      let port = gqlServer('/graphql');
      engine.graphqlPort = port;

      await startWithDelay(engine);
      return verifyEndpointSuccess(`http://localhost:${port}/graphql`, false);
    });

    it('appends configuration', (done) => {
      // Grab a random port locally:
      const srv = createServer();
      srv.on('listening', async () => {
        const extraPort = srv.address().port;
        srv.close();

        // Setup engine, with an extra frontend on that port:
        let engineConfig = {
          apiKey: 'faked',
          frontends: [{
            host: '127.0.0.1',
            endpoint: '/graphql',
            port: extraPort
          }],
          reporting: {
            noTraceVariables: true
          }
        };
        engine = new Engine({
          endpoint: '/graphql',
          engineConfig,
          graphqlPort: 1
        });
        app.use(engine.expressMiddleware());

        let port = gqlServer('/graphql');
        // Provide origins _before_ starting:
        engineConfig.origins = [
          {
            lambda: {
              functionArn: 'arn:aws:lambda:us-east-1:1234567890:function:mock_function',
              awsAccessKeyId: 'foo',
              awsSecretAccessKey: 'bar'
            }
          },
          {
            http: {
              url: `http://localhost:${port}/graphql`
            }
          }
        ];
        await startWithDelay(engine);

        // Non-HTTP origin unchanged:
        assert.strictEqual(undefined, engineConfig.origins[0].http);
        // HTTP origin has PSK injected:
        assert.notEqual(undefined, engineConfig.origins[1].http.headerSecret);

        await verifyEndpointSuccess(`http://localhost:${port}/graphql`, false);
        await verifyEndpointSuccess(`http://localhost:${extraPort}/graphql`, false);
        done();
      }).listen(0)
    });
  });

  describe('process', () => {
    it('restarts binary', async () => {
      setupEngine();
      await startWithDelay(engine);

      const url = `http://localhost:${engine.graphqlPort}/graphql`;
      await verifyEndpointSuccess(url);

      const childPid = engine.child.pid;
      assert.isTrue(isRunning(childPid));

      // Kill, wait for cycle:
      engine.child.kill();
      await new Promise(r => setTimeout(r, 300));

      const restartedPid = engine.child.pid;
      assert.notEqual(childPid, restartedPid);
      assert.isFalse(isRunning(childPid));
      assert.isTrue(isRunning(restartedPid));
    });
  })
});
