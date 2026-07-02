BUILD_DIR := build
DIST_DIR := dist
DEBUG_DIR := $(DIST_DIR)/debug
RELEASE_DIR := $(DIST_DIR)/release
OBFUSCATED_DIR := $(DIST_DIR)/obfuscated
TMP_DIR := $(BUILD_DIR)/tmp

ESBUILD := ./node_modules/.bin/esbuild
OBF := ./node_modules/.bin/javascript-obfuscator

KERNEL_ENTRY := src/jsnix.js

APP_ENTRIES := $(wildcard apps/*/app.js)
APP_DEBUG_JS := $(patsubst apps/%/app.js,$(DEBUG_DIR)/apps/%/app.js,$(APP_ENTRIES))
APP_RELEASE_JS := $(patsubst apps/%/app.js,$(RELEASE_DIR)/apps/%/app.js,$(APP_ENTRIES))
APP_OBFUSCATED_JS := $(patsubst apps/%/app.js,$(OBFUSCATED_DIR)/apps/%/app.js,$(APP_ENTRIES))
APP_DEBUG_HTML := $(patsubst apps/%/app.js,$(DEBUG_DIR)/apps/%/index.html,$(APP_ENTRIES))
APP_RELEASE_HTML := $(patsubst apps/%/app.js,$(RELEASE_DIR)/apps/%/index.html,$(APP_ENTRIES))
APP_OBFUSCATED_HTML := $(patsubst apps/%/app.js,$(OBFUSCATED_DIR)/apps/%/index.html,$(APP_ENTRIES))

KERNEL_DEBUG_ESM := $(DEBUG_DIR)/kernel/jsnix.js
KERNEL_DEBUG_GLOBAL := $(DEBUG_DIR)/kernel/jsnix.global.js
KERNEL_RELEASE_ESM := $(RELEASE_DIR)/kernel/jsnix.js
KERNEL_RELEASE_GLOBAL := $(RELEASE_DIR)/kernel/jsnix.global.js

SRC_FILES := $(shell find src -type f -name '*.js')
APP_FILES := $(shell find apps -type f -name '*.js')

ESBUILD_COMMON_FLAGS := \
	--bundle \
	--target=es2020 \
	--tree-shaking=true \
	--charset=utf8 \
	--legal-comments=linked \
	--supported:template-literal=false

KERNEL_ESM_FLAGS := \
	$(ESBUILD_COMMON_FLAGS) \
	--format=esm \
	--platform=browser

KERNEL_GLOBAL_FLAGS := \
	$(ESBUILD_COMMON_FLAGS) \
	--format=iife \
	--global-name=JSNixBundle \
	--platform=browser

APP_FLAGS := \
	$(ESBUILD_COMMON_FLAGS) \
	--format=iife \
	--platform=browser

OBF_FLAGS := \
	--compact true \
	--control-flow-flattening false \
	--dead-code-injection false \
	--identifier-names-generator mangled \
	--string-array true \
	--string-array-encoding base64 \
	--string-array-threshold 1 \
	--string-array-rotate true \
	--string-array-shuffle true \
	--rename-globals false \
	--rename-properties false \
	--self-defending false \
	--debug-protection false \
	--disable-console-output false \
	--transform-object-keys false \
	--unicode-escape-sequence false \
	--target browser

all: release

debug: debug-kernel debug-apps

release: release-kernel release-apps obfuscated-apps

kernel: release-kernel

apps: release-apps obfuscated-apps

compile: debug

obfuscate: obfuscated-apps

debug-kernel: $(KERNEL_DEBUG_ESM) $(KERNEL_DEBUG_GLOBAL)

release-kernel: $(KERNEL_RELEASE_ESM) $(KERNEL_RELEASE_GLOBAL)

debug-apps: $(APP_DEBUG_JS) $(APP_DEBUG_HTML)

release-apps: $(APP_RELEASE_JS) $(APP_RELEASE_HTML)

obfuscated-apps: $(APP_OBFUSCATED_JS) $(APP_OBFUSCATED_HTML)

$(KERNEL_DEBUG_ESM): $(SRC_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $(KERNEL_ENTRY) $(KERNEL_ESM_FLAGS) \
		--sourcemap \
		--outfile=$@

$(KERNEL_DEBUG_GLOBAL): $(SRC_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $(KERNEL_ENTRY) $(KERNEL_GLOBAL_FLAGS) \
		--sourcemap \
		--outfile=$@

$(KERNEL_RELEASE_ESM): $(SRC_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $(KERNEL_ENTRY) $(KERNEL_ESM_FLAGS) \
		--minify \
		--sourcemap \
		--outfile=$@

$(KERNEL_RELEASE_GLOBAL): $(SRC_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $(KERNEL_ENTRY) $(KERNEL_GLOBAL_FLAGS) \
		--minify \
		--sourcemap \
		--outfile=$@

$(DEBUG_DIR)/apps/%/app.js: apps/%/app.js $(SRC_FILES) $(APP_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $< $(APP_FLAGS) \
		--sourcemap \
		--outfile=$@

$(RELEASE_DIR)/apps/%/app.js: apps/%/app.js $(SRC_FILES) $(APP_FILES) Makefile
	@mkdir -p $(dir $@)
	$(ESBUILD) $< $(APP_FLAGS) \
		--minify \
		--legal-comments=none \
		--drop:console \
		--outfile=$@

$(OBFUSCATED_DIR)/apps/%/app.js: apps/%/app.js $(SRC_FILES) $(APP_FILES) Makefile
	@mkdir -p $(dir $@) $(TMP_DIR)/obfuscated/apps/$*
	$(ESBUILD) $< $(APP_FLAGS) \
		--minify \
		--legal-comments=none \
		--drop:console \
		--outfile=$(TMP_DIR)/obfuscated/apps/$*/app.js
	$(OBF) $(TMP_DIR)/obfuscated/apps/$*/app.js --output $@ $(OBF_FLAGS)

$(DEBUG_DIR)/apps/%/index.html: apps/%/index.html
	@mkdir -p $(dir $@)
	cp $< $@

$(RELEASE_DIR)/apps/%/index.html: apps/%/index.html
	@mkdir -p $(dir $@)
	tr '\n' ' ' < $< | sed -E 's/[[:space:]]+/ /g; s/> </></g' > $@

$(OBFUSCATED_DIR)/apps/%/index.html: apps/%/index.html
	@mkdir -p $(dir $@)
	tr '\n' ' ' < $< | sed -E 's/[[:space:]]+/ /g; s/> </></g' > $@

test:
	node --test tests/*.test.js

clean:
	@rm -rf $(BUILD_DIR)
	@rm -rf $(DIST_DIR)

.PHONY: \
	all \
	apps \
	clean \
	compile \
	debug \
	debug-apps \
	debug-kernel \
	kernel \
	obfuscate \
	obfuscated-apps \
	release \
	release-apps \
	release-kernel \
	test
