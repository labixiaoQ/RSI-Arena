FROM --platform=linux/amd64 debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update && apt-get install -y --no-install-recommends g++-14 make python3 zip bubblewrap ca-certificates && rm -rf /var/lib/apt/lists/*
COPY aaarena/games/monecraft/backend /opt/monecraft
COPY aaarena/src/aa_arena/legacy/ai9_relay.py /opt/arena/relay.py
# Transport-only adjustment: avoid delayed small packets on the local byte relay.
RUN python3 -c "from pathlib import Path; p=Path('/opt/arena/relay.py'); s=p.read_text(); old='peer.settimeout(None)'; assert s.count(old)==1; p.write_text(s.replace(old, old+'; peer.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)'))"
COPY aaarena/LICENSE /opt/arena/AAArena-LICENSE
COPY aaarena/games/monecraft/PROVENANCE.json /opt/arena/PROVENANCE.json
RUN make -C /opt/monecraft CXX=g++-14 all
COPY gear/examples/arena/runtime/sdk-globals.cpp /opt/arena/sdk-globals.cpp
RUN set -eu; mkdir /opt/player-sdk; for source in /opt/arena/sdk-globals.cpp /opt/monecraft/logic/src/sdk.cc /opt/monecraft/logic/src/lib_json/*.cc /opt/monecraft/platform_shared/*.cc; do \
    g++-14 -std=c++14 -O2 -fPIC -D_AI__ -I/opt/monecraft/logic/src/include -I/opt/monecraft/platform_shared/include \
    -c "$source" -o "/opt/player-sdk/$(basename "$source").o"; done
COPY gear/examples/arena/runtime/match.py /opt/arena/match.py
COPY gear/examples/arena/runtime/contract-probe.cpp /opt/arena/contract-probe.cpp
RUN cd /opt/monecraft && g++-14 -O2 -std=c++14 -w -pthread -fPIC -D_SERVER_ \
    -I. -Ilogic/src/include -Ilogic/src/include/sdk -Ishared -Ishared/include \
    -Iplatform_shared/include -Iliblogic/include -Ilibailoader/include -Iailoader/src -Iailoader/src/include -Isdk \
    /opt/arena/contract-probe.cpp logic/src/sdk.cc logic/src/MapGen*.cc logic/src/achieve.cc logic/src/output.cc shared/*.cc liblogic/*.cc \
    logic/src/lib_json/*.cc platform_shared/*.cc -o /opt/arena/contract-probe -pthread -ldl -lrt
RUN mkdir /work && chmod 1777 /work
USER 1000:1000
ENTRYPOINT ["python3", "-I", "/opt/arena/match.py"]
