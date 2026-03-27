.PHONY: check test lint all publish

all: check test lint

check:
	cargo check

test:
	cargo test

lint:
	cargo clippy -- -D warnings

publish:
	./scripts/publish.sh
