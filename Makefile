BUILD_DIR := build
DIST_DIR := dist

CC := npx esbuild
OBF := npx javascript-obfuscator

all: compile obfuscate

$(BUILD_DIR):
	@mkdir -p $(BUILD_DIR)

$(DIST_DIR):
	@mkdir -p $(DIST_DIR)

$(BUILD_DIR)/bundle.js: $(BUILD_DIR) src/index.js
	$(CC) src/index.js --bundle --minify --outfile=$(BUILD_DIR)/bundle.js

$(DIST_DIR)/main.min.js: $(DIST_DIR) $(BUILD_DIR)/bundle.js
	$(OBF) $(BUILD_DIR)/bundle.js --output $(DIST_DIR)/main.min.js \
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

compile: $(BUILD_DIR)/bundle.js

obfuscate: $(DIST_DIR)/main.min.js

.PHONY: clean
clean:
	@rm -rf $(BUILD_DIR)
	@rm -rf $(DIST_DIR)
