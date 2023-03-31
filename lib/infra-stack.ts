import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { aws_ec2 as ec2, CfnResource, StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { aws_docdb as docdb } from 'aws-cdk-lib';
import { aws_elasticloadbalancingv2 as elb} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam'
import { CfnIntegration } from 'aws-cdk-lib/aws-apigatewayv2';
import { Compatibility } from 'aws-cdk-lib/aws-ecs';

export class InfraStack extends cdk.Stack {
  public readonly api: apigateway.RestApi
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'AdcaseVpc', {
      vpcName: 'AdcaseVpc'
    });


    const loadBalancerSG = new ec2.SecurityGroup(this, 'AdcaseLoadBalancerSG', { vpc: vpc });

    loadBalancerSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow from anyone on port 80')

    const alb = new elb.ApplicationLoadBalancer( this, 'AdcaseECSALB', {
        securityGroup: loadBalancerSG,
        vpc,
      }
    )

    const elbTargetGroup = new elb.ApplicationTargetGroup(this, 'AdcaseLoadBalancerListenerTargetGroupECS', {
      targetType: elb.TargetType.IP,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      vpc,
      targetGroupName: 'AdcaseLBListenerTargetGroupECS'
    })

    const albListener = new elb.ApplicationListener(this, 'AdcaseECSApplicationListener', {
      loadBalancer: alb,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      defaultAction: elb.ListenerAction.forward([elbTargetGroup])
    })

    // Define ECR Setup
    const repository = new ecr.Repository(this, "adcase", {
      repositoryName: "adcase-api"
    });

    //  Define the ECS setup
    const ecsCluster = new ecs.Cluster(this, 'AdcaseECSCluster', {
      vpc,
      clusterName: 'adcase-ecs-cluster'
    })

    const ecsSG = new ec2.SecurityGroup(this, 'AdcaseECSSecurityGroup', {
      vpc,
      securityGroupName: 'adcase-ecs-sg'
    })

    // const ecsTaskDefinition = new ecs.FargateTaskDefinition(this, 'Adcase-ECS-Task-Definition', {
    //   cpu: 512,
    //   memoryLimitMiB: 1024,
    //   taskRole: new iam.Role(this, 'Adcase-ECS-Task-Role', {
    //     assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    //   }),
    //   executionRole: new iam.Role(this, 'ECS-Task-Execution-Role', {
    //     assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    //     managedPolicies: [
    //       iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    //     ]
    //   })
    // })
    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

    const ecsTaskDefinition = new ecs.TaskDefinition(this, 'ApiTaskDefinition', {
      cpu: '256',
      compatibility: Compatibility.EC2
    });
    ecsTaskDefinition.addToExecutionRolePolicy(executionRolePolicy);
    ecsTaskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['documentdb:*']
    }));

    const ecsContainer = ecsTaskDefinition.addContainer('Adcase-ECS-Container', {
      image: ecs.ContainerImage.fromRegistry('/adcase/adcase-ecs-cluster'),
      memoryLimitMiB: 2048,
      containerName: 'adcase-ecs-container'
    })

    ecsContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP
    })

    const ecsService = new ecs.Ec2Service(this, 'AdcaseECSService', {
      cluster: ecsCluster,
      taskDefinition: ecsTaskDefinition,
    })

    albListener.addTargets('ECS', {
      port: 80,
      targets: [
        ecsService.loadBalancerTarget({
          containerName: 'adcase-ecs-container',
          containerPort: 3000
        })
      ]
    })

    // Document DB Setup
    const documentDBCluster = new docdb.DatabaseCluster(this, 'AdcaseDocDBCluster', {
      masterUser: {
        username: 'CaseAdmin', // I have created this in AWS Console
        excludeCharacters: '\"@/:', // optional, defaults to the set "\"@/" and is also used for eventually created rotations
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.R5, ec2.InstanceSize.MEDIUM),
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      vpc,
    })

    documentDBCluster.connections.allowDefaultPortFromAnyIpv4('Hello world')

    const instanceType = new ec2.InstanceType('AdcaseDocDBInstanceType');

    const databaseInstance = new docdb.DatabaseInstance(this, 'AdCaseDatabaseInstance', {
      cluster: documentDBCluster,
      instanceType,
    });

    const httpVpcLink = new CfnResource(this, 'HttpVpcLink', {
      type: 'AWS::ApiGatewayV2::VpcLink',
      properties: {
        Name: 'VpcLink',
      }
    });

    const api = new apigateway.RestApi(this, 'adcase-api', {
      deployOptions: {
        dataTraceEnabled: true,
      },
    });

    api.root.addMethod('ANY');

    const users = api.root.addResource('users');
    users.addMethod('GET');
    users.addMethod('POST');

    const integration = new CfnIntegration(this, 'RestApiGatewayIntegration', {
      apiId: api.restApiId,
      connectionId: httpVpcLink.ref,
      connectionType: 'VPC_LINK',
      description: 'API Integration with ECS',
      integrationMethod: 'ANY', // for GET and POST, use ANY
      integrationType: 'HTTP_PROXY',
      integrationUri: ecsService.serviceArn,
      payloadFormatVersion: '1.0', // supported values for Lambda proxy integrations are 1.0 and 2.0. For all other integrations, 1.0 is the only supported value
    });
   }
}
