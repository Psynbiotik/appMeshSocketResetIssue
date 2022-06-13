# Welcome to AppMeshIssue!
This projects demonstrates an issue with AWS App Mesh.

# Excutive summary
The issue is after using mulitple connections, waiting 10 minutes, any connection after will fail.

# Prerequisites NPM and AWS CDK:
https://docs.npmjs.com/downloading-and-installing-node-js-and-npm
https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html

# To deploy:
./run.sh
or
npm install && cd fargate && npm install && cd .. && cdk deploy

# Details on what this project does
This project uses AWS CDK to create a from scratch app mesh deployment to demonstrate the issue.

This project has several parts:
The cdk startup script in lib/app_mesh_issu_stack.ts
An App mesh that does not allow outside connections. There is no route to the app mesh as it is not needed for this demonstration
A single container in the app mesh, this is the 'fargete' directory.
A single lambda, this is the 'lambda' directory.

All components are bare bones. The lambda is nothing more then a hello world. The fargate container only contains a health check endpoint and a loop where it calls the lambda 1000 times in quick succession, pauses for 10 minutes then makes a few calls to illustrate the issue.

When looking at the logs you can search for '-----' to find the break between the inital calls and when the failures begin. You should see about 14 failures then success again.