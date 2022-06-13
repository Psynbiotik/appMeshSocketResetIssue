const express = require("express");
const pino = require("pino");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

exports.logger = pino({ level: "info" });

// Setup simple server to respond to health checks
const app = express();
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Manual invoke endpoint, not needed just provided for convienence
app.get("/demo", (req, res) => {
  exports.logger.info("Manual call invoked");
  return lambdaClient
    .send(new InvokeCommand(invokeParams))
    .then((result) => {
      exports.logger.info("successfull");
      res.status(200).send("OK");
    })
    .catch((error) => {
      if (error && error.code === "ECONNRESET") {
        // received socket hang up
        exports.logger.error("failed with ECONNRESET");
        res.status(500).send("ECONNRESET received");
      }
      res.status(500).send("unknown error");
    });
});

app.listen(8080, () => {
  exports.logger.info("🚀 Server ready");
});

// Start crafting call to lambda
const lambdaClient = new LambdaClient({
  lambda: "2015-03-31",
});

const invokeParams = {
  FunctionName: `${process.env.LAMBDA_ARN}`,
  ClientContext: Buffer.from(
    JSON.stringify({ name: "demo-issue-fargate" }, null, 2)
  ).toString("base64"),
  InvocationType: "RequestResponse",
  Payload: Buffer.from(
    JSON.stringify(
      {
        body: "testing",
        path: "/demo/issue",
        httpMethod: "GET",
      },
      null,
      2
    )
  ),
};

// helper functions
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let callCounter = 0;

async function callLambda() {
  const counter = callCounter++;
  lambdaClient
    .send(new InvokeCommand(invokeParams))
    .then((result) => {
      exports.logger.info("successfull invocation: " + counter);
    })
    .catch((error) => {
      if (error && error.code === "ECONNRESET") {
        // received socket hang up
        exports.logger.error(
          "failed with ECONNRESET on invocation: " + counter
        );
      } else {
        exports.logger.error("Unknown error on invocation: " + counter);
      }
    });
}

async function main() {
  exports.logger.info(`Targeting lambda: ${process.env.LAMBDA_ARN}`);

  // Start calling the lambda
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 100; j++) {
      callLambda();
    }
  }

  await sleep(60000); // wait for 1 minute to allow logs to clear up a bit

  const breakTime = 540000;
  exports.logger.info("Breaking for " + breakTime + " milliseconds");
  // Wait 9 more minutes ( issue starts at 5 min 50 seconds? )
  await sleep(breakTime);

  exports.logger.info("-------Sending calls after break---------");

  // These calls should fail
  for (let i = 0; i < 35; i++) {
    // it typically takes 15 tries for me to break through 2 times
    callLambda();
    await sleep(100); // wait a bit between calls
  }
}

main();
