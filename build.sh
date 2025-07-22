npx esbuild src/index.js --bundle --minify --outfile=build/bundle.js
npx javascript-obfuscator build/bundle.js --output dist/main.min.js \
   --compact true \
   --control-flow-flattening false \
   --dead-code-injection false \
   --string-array true \
   --string-array-encoding base64 \
   --string-array-threshold 1 \
   --rename-globals true \
   --self-defending false \
   --disable-console-output true \
   --transform-object-keys true
