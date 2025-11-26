#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploy OpenTelemetry observability stack to Kubernetes

.DESCRIPTION
    This script deploys the complete observability infrastructure including:
    - Cert-Manager (for OTel Operator)
    - OpenTelemetry Operator
    - OpenTelemetry Collector
    - Jaeger distributed tracing
    - Auto-instrumentation configuration
    - Example microservices

.PARAMETER SkipPrerequisites
    Skip installation of cert-manager and OTel Operator

.PARAMETER DeployServices
    Deploy example microservices (user, product, order services)

.PARAMETER ClusterContext
    Kubernetes cluster context to use (default: current context)

.EXAMPLE
    .\deploy-observability.ps1
    Deploy everything to current Kubernetes context

.EXAMPLE
    .\deploy-observability.ps1 -SkipPrerequisites
    Skip prerequisites and only deploy observability stack

.EXAMPLE
    .\deploy-observability.ps1 -DeployServices
    Also deploy example microservices
#>

[CmdletBinding()]
param(
    [switch]$SkipPrerequisites,
    [switch]$DeployServices,
    [string]$ClusterContext = ""
)

# Color functions
function Write-Success { param($msg) Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "ℹ️  $msg" -ForegroundColor Cyan }
function Write-Warning { param($msg) Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Error { param($msg) Write-Host "❌ $msg" -ForegroundColor Red }
function Write-Step { param($step, $msg) Write-Host "`n🚀 Step $step`: $msg" -ForegroundColor Magenta }

# Check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
    
    # Check kubectl
    if (!(Get-Command kubectl -ErrorAction SilentlyContinue)) {
        Write-Error "kubectl is not installed. Please install kubectl first."
        exit 1
    }
    Write-Success "kubectl is installed"
    
    # Check cluster connectivity
    try {
        kubectl cluster-info | Out-Null
        Write-Success "Connected to Kubernetes cluster"
    }
    catch {
        Write-Error "Cannot connect to Kubernetes cluster. Check your kubeconfig."
        exit 1
    }
    
    # Show current context
    $context = kubectl config current-context
    Write-Info "Current context: $context"
    
    if ($ClusterContext -and $context -ne $ClusterContext) {
        Write-Warning "Switching to context: $ClusterContext"
        kubectl config use-context $ClusterContext
    }
}

# Install cert-manager
function Install-CertManager {
    Write-Step "1" "Installing Cert-Manager"
    
    $certManagerExists = kubectl get namespace cert-manager 2>$null
    if ($certManagerExists) {
        Write-Info "Cert-Manager already installed"
        return
    }
    
    Write-Info "Applying Cert-Manager manifests..."
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
    
    Write-Info "Waiting for Cert-Manager to be ready..."
    kubectl wait --for=condition=Available --timeout=300s deployment/cert-manager -n cert-manager
    kubectl wait --for=condition=Available --timeout=300s deployment/cert-manager-webhook -n cert-manager
    kubectl wait --for=condition=Available --timeout=300s deployment/cert-manager-cainjector -n cert-manager
    
    Write-Success "Cert-Manager installed successfully"
}

# Install OpenTelemetry Operator
function Install-OTelOperator {
    Write-Step "2" "Installing OpenTelemetry Operator"
    
    $otelNamespace = kubectl get namespace opentelemetry-operator-system 2>$null
    if ($otelNamespace) {
        Write-Info "OpenTelemetry Operator already installed"
        return
    }
    
    Write-Info "Applying OpenTelemetry Operator manifests..."
    kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml
    
    Write-Info "Waiting for OpenTelemetry Operator to be ready..."
    kubectl wait --for=condition=Available --timeout=300s deployment/opentelemetry-operator-controller-manager -n opentelemetry-operator-system
    
    Write-Success "OpenTelemetry Operator installed successfully"
}

# Deploy observability namespace
function Deploy-ObservabilityNamespace {
    Write-Step "3" "Creating Observability Namespace"
    
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $k8sDir = Join-Path $scriptDir "k8s"
    
    Write-Info "Applying observability namespace..."
    kubectl apply -f "$k8sDir/observability/otel-collector.yaml" --dry-run=client -o yaml | Select-String -Pattern "kind: Namespace" -Context 0,5 | kubectl apply -f -
    
    Write-Success "Observability namespace created"
}

# Deploy OpenTelemetry Collector
function Deploy-OTelCollector {
    Write-Step "4" "Deploying OpenTelemetry Collector"
    
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $k8sDir = Join-Path $scriptDir "k8s"
    
    Write-Info "Applying OpenTelemetry Collector configuration..."
    kubectl apply -f "$k8sDir/observability/otel-collector.yaml"
    
    Write-Info "Waiting for OpenTelemetry Collector to be ready..."
    Start-Sleep -Seconds 10
    kubectl wait --for=condition=Available --timeout=300s deployment -l app.kubernetes.io/name=otel-collector.observability -n observability 2>$null
    
    Write-Success "OpenTelemetry Collector deployed successfully"
}

# Deploy Jaeger
function Deploy-Jaeger {
    Write-Step "5" "Deploying Jaeger"
    
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $k8sDir = Join-Path $scriptDir "k8s"
    
    Write-Info "Applying Jaeger configuration..."
    kubectl apply -f "$k8sDir/observability/jaeger.yaml"
    
    Write-Info "Waiting for Jaeger to be ready..."
    kubectl wait --for=condition=Available --timeout=300s deployment/jaeger-all-in-one -n observability
    
    Write-Success "Jaeger deployed successfully"
    
    # Show Jaeger UI port-forward command
    Write-Info "To access Jaeger UI, run:"
    Write-Host "    kubectl port-forward -n observability svc/jaeger-query 16686:16686" -ForegroundColor Yellow
}

# Deploy auto-instrumentation
function Deploy-AutoInstrumentation {
    Write-Step "6" "Deploying Auto-Instrumentation Configuration"
    
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $k8sDir = Join-Path $scriptDir "k8s"
    
    Write-Info "Applying auto-instrumentation configuration..."
    kubectl apply -f "$k8sDir/observability/instrumentation.yaml"
    
    Write-Success "Auto-instrumentation configuration deployed"
}

# Deploy example services
function Deploy-ExampleServices {
    Write-Step "7" "Deploying Example Microservices"
    
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $k8sDir = Join-Path $scriptDir "k8s"
    
    Write-Info "Applying example services..."
    kubectl apply -f "$k8sDir/services/example-services.yaml"
    
    Write-Info "Waiting for services to be ready..."
    kubectl wait --for=condition=Available --timeout=300s deployment/user-service -n default 2>$null
    kubectl wait --for=condition=Available --timeout=300s deployment/product-service -n default 2>$null
    kubectl wait --for=condition=Available --timeout=300s deployment/order-service -n default 2>$null
    
    Write-Success "Example microservices deployed successfully"
}

# Verify deployment
function Test-Deployment {
    Write-Step "8" "Verifying Deployment"
    
    Write-Info "Checking observability namespace..."
    kubectl get pods -n observability
    
    Write-Info "`nChecking OpenTelemetry Collector..."
    kubectl get opentelemetrycollector -n observability
    
    Write-Info "`nChecking Instrumentation..."
    kubectl get instrumentation -n observability
    
    if ($DeployServices) {
        Write-Info "`nChecking example services..."
        kubectl get pods -n default -l 'app in (user-service,product-service,order-service)'
    }
    
    Write-Success "Deployment verification complete"
}

# Show next steps
function Show-NextSteps {
    Write-Host "`n" -NoNewline
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "                    🎉 DEPLOYMENT COMPLETE                      " -ForegroundColor Green
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
    
    Write-Host "`n📋 NEXT STEPS:" -ForegroundColor Yellow
    Write-Host ""
    
    Write-Host "1️⃣  Access Jaeger UI:" -ForegroundColor Cyan
    Write-Host "    kubectl port-forward -n observability svc/jaeger-query 16686:16686"
    Write-Host "    Open: http://localhost:16686"
    Write-Host ""
    
    Write-Host "2️⃣  Access Backstage Function Analytics:" -ForegroundColor Cyan
    Write-Host "    cd backstage"
    Write-Host "    yarn dev"
    Write-Host "    Open: http://localhost:3000/function-analytics"
    Write-Host ""
    
    Write-Host "3️⃣  Deploy your microservices with auto-instrumentation:" -ForegroundColor Cyan
    Write-Host "    Add this annotation to your Deployment:"
    Write-Host "    instrumentation.opentelemetry.io/inject-nodejs: `"observability/auto-instrumentation`""
    Write-Host ""
    
    Write-Host "4️⃣  Register services in Backstage catalog:" -ForegroundColor Cyan
    Write-Host "    Create catalog-info.yaml with:"
    Write-Host "    metadata:"
    Write-Host "      annotations:"
    Write-Host "        jaegertracing.io/service-name: `"your-service-name`""
    Write-Host ""
    
    Write-Host "5️⃣  Generate traffic to see traces:" -ForegroundColor Cyan
    Write-Host "    kubectl port-forward -n default svc/user-service 8080:80"
    Write-Host "    curl http://localhost:8080/api/users"
    Write-Host ""
    
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
}

# Main execution
try {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║  OpenTelemetry Observability Stack Deployment            ║" -ForegroundColor Cyan
    Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    
    Test-Prerequisites
    
    if (!$SkipPrerequisites) {
        Install-CertManager
        Install-OTelOperator
    }
    else {
        Write-Warning "Skipping prerequisites installation"
    }
    
    Deploy-ObservabilityNamespace
    Deploy-OTelCollector
    Deploy-Jaeger
    Deploy-AutoInstrumentation
    
    if ($DeployServices) {
        Deploy-ExampleServices
    }
    else {
        Write-Info "Skipping example services deployment (use -DeployServices to deploy)"
    }
    
    Test-Deployment
    Show-NextSteps
    
    exit 0
}
catch {
    Write-Error "Deployment failed: $_"
    Write-Host $_.ScriptStackTrace -ForegroundColor Red
    exit 1
}
