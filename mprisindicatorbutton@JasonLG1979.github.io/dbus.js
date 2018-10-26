/*
 * Mpris Indicator Button extension for Gnome Shell 3.26+
 * Copyright 2018 Jason Gray (JasonLG1979)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * If this extension breaks your desktop you get to keep both pieces...
 */
"use strict";

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;

const Me = imports.misc.extensionUtils.getCurrentExtension();

// Basically a re-implementation of the widely used
// Gio.DBusProxy.makeProxyWrapper tailored 
// for our particular needs.
function _makeProxyWrapper(interfaceXml) {
    let nodeInfo = Gio.DBusNodeInfo.new_for_xml(interfaceXml);
    let info = nodeInfo.interfaces[0];
    let iname = info.name;
    return function(name, object, flags, asyncCallback) {
        let cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | flags,
            info,
            name,
            object,
            iname,
            cancellable,
            (source, result) => {
                let proxy = null;
                let error = null;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    error = e;
                }
                if (proxy) {
                    if (proxy.g_name_owner) {
                        asyncCallback(proxy, null);
                    } else {
                        error = Gio.DBusError.new_for_dbus_error(
                            " No Owner",
                            name + " has no owner."
                        );
                        asyncCallback(null, error);
                    }
                } else {
                    if (!error) {
                        error = Gio.DBusError.new_for_dbus_error(
                            " Unknow Error",
                            name
                        );
                    }
                    asyncCallback(null, error);
                }
            }
        ); 
        return cancellable;
    };
}

function logError(error) {
    // Cancelling counts as an error don't spam the logs.
    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
        global.log("[" + Me.metadata.uuid + "]: " + error.message);
    }
}

const DBusProxy = _makeProxyWrapper(
`<node>
<interface name="org.freedesktop.DBus">
  <method name="GetConnectionUnixProcessID">
    <arg type="s" direction="in" name="busName"/>
    <arg type="u" direction="out" name="pid"/>
  </method>
  <method name="GetNameOwner">
    <arg type="s" direction="in" name="busName"/>
    <arg type="s" direction="out" name="nameOwner"/>
  </method>
  <method name="ListNames">
    <arg type="as" direction="out" name="names" />
  </method>
  <signal name="NameOwnerChanged">
    <arg type="s" direction="out" name="name" />
    <arg type="s" direction="out" name="oldOwner" />
    <arg type="s" direction="out" name="newOwner" />
  </signal>
</interface>
</node>`);

var MprisProxy = _makeProxyWrapper(
`<node>
<interface name="org.mpris.MediaPlayer2">
  <method name="Raise" />
  <property name="CanRaise" type="b" access="read" />
  <property name="Identity" type="s" access="read" />
  <property name="DesktopEntry" type="s" access="read" />
</interface>
</node>`);

var MprisPlayerProxy = _makeProxyWrapper(
`<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause" />
  <method name="Next" />
  <method name="Previous" />
  <method name="Stop" />
  <method name="Play" />
  <property name="CanGoNext" type="b" access="read" />
  <property name="CanGoPrevious" type="b" access="read" />
  <property name="CanPlay" type="b" access="read" />
  <property name="CanPause" type="b" access="read" />
  <property name="Metadata" type="a{sv}" access="read" />
  <property name="PlaybackStatus" type="s" access="read" />
</interface>
</node>`);

var DBusProxyHandler = GObject.registerClass({
    GTypeName: "DBusProxyHandler",
    Signals: {
        "add-player": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        },
        "remove-player": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        },
        "change-player-owner": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        }
    }
}, class DBusProxyHandler extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._cancellable = new DBusProxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            this._onProxyReady.bind(this)
        );
    }

    _onProxyReady(proxy, error) {
        this._cancellable.run_dispose();
        this._cancellable = null;
        if (proxy) {
            this._proxy = proxy;
            this._proxy.ListNamesRemote(([busNames]) => {
                busNames.filter(n => n.startsWith("org.mpris.MediaPlayer2.")).sort().forEach(busName => {
                    this._proxy.GetConnectionUnixProcessIDRemote(busName, (pid) => {
                        this._proxy.GetNameOwnerRemote(busName, (nameOwner) => {
                            this.emit("add-player", [busName, nameOwner, pid].join(" "));
                        });
                    });
                });
            });

            this._proxy.connectSignal("NameOwnerChanged", (proxy, sender, [busName, oldOwner, newOwner]) => {
                if (busName.startsWith("org.mpris.MediaPlayer2.")) { 
                    if (newOwner && !oldOwner) {
                        this._proxy.GetConnectionUnixProcessIDRemote(busName, (pid) => {
                            this.emit("add-player", [busName, newOwner, pid].join(" "));
                        });
                    } else if (oldOwner && !newOwner) {
                        this.emit("remove-player", busName);
                    } else if (oldOwner && newOwner) {
                        this._proxy.GetConnectionUnixProcessIDRemote(busName, (pid) => {
                            this.emit("change-player-owner", [busName, newOwner, pid].join(" "));
                        });
                    }
                }
            });
        } else {
            logError(error);
        }
    }

    destroy() {
        if (this._cancellable) {
            if (!this._cancellable.is_cancelled()) {
                this._cancellable.cancel();
            }
            this._cancellable.run_dispose();
        }
        if (this._proxy) {
            this._proxy.run_dispose();
        }
        this._proxy = null;
        this._cancellable = null;
        super.run_dispose();
    }
});

var MprisProxyHandler = GObject.registerClass({
    GTypeName: "MprisProxyHandler",
    Properties: {
        "show-stop": GObject.ParamSpec.boolean(
            "show-stop",
            "show-stop-prop",
            "If the stop button should be shown",
            GObject.ParamFlags.READABLE,
            false
        ),
        "prev-reactive": GObject.ParamSpec.boolean(
            "prev-reactive",
            "prev-reactive-prop",
            "If the prev button should be reactive",
            GObject.ParamFlags.READABLE,
            false
        ),
        "playpause-reactive": GObject.ParamSpec.boolean(
            "playpause-reactive",
            "playpause-reactive-prop",
            "If the playpause button should be reactive",
            GObject.ParamFlags.READABLE,
            false
        ),
        "playpause-icon-name": GObject.ParamSpec.string(
            "playpause-icon-name",
            "playpause-icon-name",
            "The name of the icon in the playpause button",
            GObject.ParamFlags.READABLE,
            "media-playback-start-symbolic"
        ),
        "next-reactive": GObject.ParamSpec.boolean(
            "next-reactive",
            "next-reactive-prop",
            "If the next button should be reactive",
            GObject.ParamFlags.READABLE,
            false
        ),
        "cover-url": GObject.ParamSpec.string(
            "cover-url",
            "cover-url-prop",
            "the url of the current track's cover art",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "artist": GObject.ParamSpec.string(
            "artist",
            "artist-prop",
            "The current track's artist",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "title": GObject.ParamSpec.string(
            "title",
            "title-prop",
            "The current track's title",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "playback-status": GObject.ParamSpec.int(
            "playback-status",
            "playback-status-prop",
            "The current playback-status. Playing = 2, Paused = 1, Stopped = 0",
            GObject.ParamFlags.READABLE,
            0
        )
    }
}, class MprisProxyHandler extends GObject.Object {
    _init(busName, onAsyncInitComplete) {
        super._init();
        this._busName = busName;
        this._onAsyncInitComplete = onAsyncInitComplete;
        this._playerProxy = null;
        this._mprisProxy = null;
        this._player_name = "";
        this._desktop_entry = "";
        this._show_stop = false;
        this._prev_reactive = false;
        this._playpause_reactive = false;
        this._playpause_icon_name = "media-playback-start-symbolic";
        this._next_reactive = false;
        this._cover_url = "";
        this._artist = "";
        this._title = "";
        this._playback_status = 0;
        this._cancellable = new MprisProxy(
            busName,
            "/org/mpris/MediaPlayer2",
            Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
            this._onMprisProxyReady.bind(this)
        );
    }

    get player_name() {
        return this._player_name;
    }

    get desktop_entry() {
        return this._desktop_entry;
    }

    get show_stop() {
        return this._show_stop;
    }

    get prev_reactive() {
        return this._prev_reactive;
    }

    get playpause_reactive() {
        return this._playpause_reactive;
    }

    get playpause_icon_name() {
        return this._playpause_icon_name;
    }

    get next_reactive() {
        return this._next_reactive;
    }

    get cover_url() {
        return this._cover_url;
    }

    get artist() {
        return this._artist;
    }

    get title() {
        return this._title;
    }

    get playback_status() {
        return this._playback_status;
    }

    raise() {
        if (this._mprisProxy && this._mprisProxy.CanRaise) {
            try {
                this._playerProxy.PlayPauseRemote();
                return true;
            } catch(error) {
                logError(error);
                return false;
            }
        }
        return false;
    }

    playPause() {
        if (this._playerProxy) {
            try {
                if (this._playerProxy.CanPause && this._playerProxy.CanPlay) {
                    this._playerProxy.PlayPauseRemote();
                } else if (this._playerProxy.CanPlay) {
                    this._playerProxy.PlayRemote();
                }
            } catch(error) {
                logError(error);
            }
        }
    }

    stop() {
        if (this._playerProxy) {
            try {
                this._playerProxy.StopRemote();
            } catch(error) {
                logError(error);
            }
        }
    }

    playPauseStop() {
        if (this._playerProxy) {
            try {
                let isPlaying = this._playback_status === 2;
                let canPlay = this._playerProxy.CanPlay;
                let canPause = this._playerProxy.CanPause;
                if (canPlay && canPause) {
                    this._playerProxy.PlayPauseRemote();
                    return true;
                } else if (canPlay && !isPlaying) {
                    this._playerProxy.PlayRemote();
                    return true;
                } else if (isPlaying) {
                    this._playerProxy.StopRemote();
                    return true;
                }
            } catch(error) {
                logError(error);
                return false;
            }
        }
        return false;
    }

    previous() {
        if (this._playerProxy && this._playerProxy.CanGoPrevious) {
            try {
                this._playerProxy.PreviousRemote();
                return true;
            } catch(error) {
                logError(error);
                return false;
            }
        }
        return false;
    }

    next() {
        if (this._playerProxy && this._playerProxy.CanGoNext) {
            try {
                this._playerProxy.NextRemote();
                return true;
            } catch(error) {
                logError(error);
                return false;
            }
        }
        return false;
    }

    _get_playback_status() {
        if (this._playerProxy) {
            let status = (this._playerProxy.PlaybackStatus || "").toLowerCase();
            if (status === "playing") {
                return 2;
            } else if (status === "paused") {
                return 1;
            }
        }
        return 0;
    }

    _updateMetadata() {
        let artist = "";
        let title = "";
        let coverUrl = "";
        let metadata = this._playerProxy.Metadata || {};
        let metadataKeys = Object.keys(metadata);
        let artistKeys = [
            "xesam:artist",
            "xesam:albumArtist",
            "xesam:composer",
            "xesam:lyricist"
        ];

        // Be rather exhaustive and liberal
        // as far as what constitutes an "artist".
        if (metadataKeys.includes("rhythmbox:streamTitle")) {
            artist = metadata["rhythmbox:streamTitle"].unpack();
        }
        if (!artist) {
            for (let key of artistKeys) {
                if (metadataKeys.includes(key)) {
                    artist = metadata[key].deep_unpack().join(", ");
                    if (artist) {
                        break;
                    }
                }
            }
        }

        artist = artist || this._player_name;

        // Prefer the track title, but in it's absence if the
        // track number and album title are available use them.
        // For Example, "5 - My favorite Album". 
        if (metadataKeys.includes("xesam:title")) {
            title = metadata["xesam:title"].unpack();
        }
        if (!title && metadataKeys.includes("xesam:trackNumber")
            && metadataKeys.includes("xesam:album")) {
            let trackNumber = metadata["xesam:trackNumber"].unpack();
            let album = metadata["xesam:album"].unpack();
            if (trackNumber && album) {
                title = trackNumber + " - " + album;
            }
        }

        if (metadataKeys.includes("mpris:artUrl")) {
            coverUrl = metadata["mpris:artUrl"].unpack();
        }

        if (this._cover_url !== coverUrl) {
            this._cover_url = coverUrl;
            this.notify("cover-url");
        }
        if (this._artist !== artist) {
            this._artist = artist;
            this.notify("artist");
        }
        if (this._title !== title) {
            this._title = title;
            this.notify("title");
        }
    }

    _updateProps() {
        let playPauseIconName = "media-playback-start-symbolic";
        let playPauseReactive = false;
        let showStop = false;
        let status = this._get_playback_status();
        let isPlaying = status === 2;
        let canPlay = this._playerProxy.CanPlay || false;
        let canPause = this._playerProxy.CanPause || false;
        let canGoPrevious = this._playerProxy.CanGoPrevious || false;
        let canGoNext = this._playerProxy.CanGoNext || false; 

        if (canPause && canPlay) {
            playPauseIconName = isPlaying ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
            playPauseReactive = true;
        } else {
            if (canPlay) {
                showStop = true;
            }
            playPauseIconName = "media-playback-start-symbolic";
            playPauseReactive = canPlay;
        }

        if (this._show_stop !== showStop) {
            this._show_stop = showStop;
            this.notify("show-stop");
        }
        if (this._prev_reactive !== canGoPrevious) {
            this._prev_reactive = canGoPrevious;
            this.notify("prev-reactive");
        }
        if (this._playpause_icon_name !== playPauseIconName) {
            this._playpause_icon_name = playPauseIconName;
            this.notify("playpause-icon-name");
        }
        if (this._playpause_reactive !== playPauseReactive) {
            this._playpause_reactive = playPauseReactive;
            this.notify("playpause-reactive");
        }
        if (this._next_reactive !== canGoNext) {
            this._next_reactive = canGoNext;
            this.notify("next-reactive");
        }
        if (this._playback_status !== status) {
            this._playback_status = status;
            this.notify("playback_status");
        }
    }

    _onMprisProxyReady(mprisProxy, error) {
        this._cancellable.run_dispose();
        this._cancellable = null;
        if (mprisProxy) {
            this._mprisProxy = mprisProxy;
            this._player_name = this._mprisProxy.Identity || "";
            this._desktop_entry = (this._mprisProxy.DesktopEntry || "").split("/").pop().replace(".desktop", "");
            this._cancellable = new MprisPlayerProxy(
                this._busName,
                "/org/mpris/MediaPlayer2",
                Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
                this._onPlayerProxyReady.bind(this)
            );
        } else {
            logError(error);
            this._onAsyncInitComplete();
        }
    }

    _onPlayerProxyReady(playerProxy, error) {
        this._cancellable.run_dispose();
        this._cancellable = null;
        if (playerProxy) {
            this._playerProxy = playerProxy;
            this._onAsyncInitComplete(true);
            this._updateProps();
            this._updateMetadata();
            this._playerProxy.connect("g-properties-changed", (proxy, props, invalidated_props) => {
                props = Object.keys(props.deep_unpack()).concat(invalidated_props);
                if (props.includes("PlaybackStatus") || props.some(prop => prop.startsWith("Can"))) {
                    this._updateProps();
                }

                if (props.includes("Metadata")) {
                    this._updateMetadata();
                }
            });
        } else {
            logError(error);
            this._onAsyncInitComplete();
        }
    }

    destroy() {
        if (this._cancellable) {
            if (!this._cancellable.is_cancelled()) {
                this._cancellable.cancel();
            }
            this._cancellable.run_dispose();
        }
        if (this._playerProxy) {
            this._playerProxy.run_dispose();
        }
        if (this._mprisProxy) {
            this._mprisProxy.run_dispose();
        }
        this._busName = null;
        this._onAsyncInitComplete = null;
        this._playerProxy = null;
        this._mprisProxy = null;
        this._player_name = null;
        this._desktop_entry = null;
        this._show_stop = null;
        this._prev_reactive = null;
        this._playpause_reactive = null;
        this._playpause_icon_name = null;
        this._next_reactive = null;
        this._cover_url = null;
        this._artist = null;
        this._title = null;
        this._playback_status = null;
        this._cancellable = null;
        super.run_dispose();
    }
});