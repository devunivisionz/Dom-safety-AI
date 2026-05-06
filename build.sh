#!/usr/bin/env bash
# exit on error
set -o errexit

echo "Starting build process with npm..."

# Install dependencies using npm (this will also trigger postinstall if configured, 
# but we call playwright install explicitly to be sure)
npm install

# Ensure Playwright chromium is installed without --with-deps (to avoid sudo)
echo "Installing Playwright Chromium..."
npx playwright install chromium

echo "Build complete!"
