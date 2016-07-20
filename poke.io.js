'use strict';

//Why use Bluebird, it's 2016 all the way, native Promised ftw.
const request = require('request-promise');
const geocoder = require('geocoder');
const events = require('events');
const ProtoBuf = require('protobufjs');
const GoogleOAuth = require('gpsoauthnode');
const Long = require('long');
const ByteBuffer = require('bytebuffer');
//const bignum = require('bignum');

const s2 = require('simple-s2-node');
const Logins = require('./logins');

let builder = ProtoBuf.loadProtoFile('pokemon.proto');
if (builder === null) {
    builder = ProtoBuf.loadProtoFile(__dirname + '/pokemon.proto');
}

const pokemonProto = builder.build();
const {RequestEnvelop, ResponseEnvelop} = pokemonProto;
const EventEmitter = events.EventEmitter;
const api_url = 'https://pgorelease.nianticlabs.com/plfe/rpc';
//const lowMask = bignum('ffffffff', 16);

function GetCoords(self) {
    let {latitude, longitude} = self.playerInfo;
    return [latitude, longitude];
};


Long.fromBignum = function (b, signed) {
    return new Long(b.and(lowMask).toNumber(), b.shiftRight(32).and(lowMask).toNumber(), signed ? false : true);
}

function getNeighbors(lat, lng) {
    var origin = s2.S2CellId.from_lat_lng(s2.S2LatLng.from_degrees(lat, lng)).parent(15);
    var walk = [origin.id()];
    // 10 before and 10 after
    var next = origin.next();
    var prev = origin.prev();
    for (var i = 0; i < 10; i++) {
        // in range(10):
        walk.push(prev.id());
        walk.push(next.id());
        next = next.next();
        prev = prev.prev();
    }
    return walk;
}

function Pokeio() {
    var self = this;
    self.events = new EventEmitter();
    self.j = request.jar();
    self.request = request.defaults({jar: self.j});

    self.google = new GoogleOAuth();

    self.playerInfo = {
        accessToken: '',
        debug: true,
        latitude: 0,
        longitude: 0,
        altitude: 0,
        locationName: '',
        provider: '',
        apiEndpoint: ''
    };

    self.DebugPrint = function (str) {
        if (self.playerInfo.debug === true) {
            //self.events.emit('debug',str)
            console.log(str);
        }
    };

    function apiRequest(api_endpoint, access_token, req) {
        // Auth
        var auth = new RequestEnvelop.AuthInfo({
            provider: self.playerInfo.provider,
            token: new RequestEnvelop.AuthInfo.JWT(access_token, 59)
        });

        var f_req = new RequestEnvelop({
            unknown1: 2,
            rpc_id: 1469378659230941192,

            requests: req,

            latitude: self.playerInfo.latitude,
            longitude: self.playerInfo.longitude,
            altitude: self.playerInfo.altitude,

            auth: auth,
            unknown12: 989
        });

        return self.request.post({
            url: api_endpoint,
            body: f_req.encode().toBuffer(),
            encoding: null,
            headers: {
                'User-Agent': 'Niantic App'
            }
        })
            .then(function (body) {
                if (!body) {
                    throw "RPC Server Offline";
                }
                return ResponseEnvelop.decode(body);
            }, function (err) {
                console.warn(err);
                return err.decoded;
            });

    }

    self.init = function (username, password, location, provider) {
        return Promise.resolve()
            .then(()=> {
                if (provider !== 'ptc' && provider !== 'google') {
                    throw 'Invalid provider. Should be either "google" or "ptc"';
                }
                // set provider
                self.playerInfo.provider = provider;
                // Updating location
                return self.SetLocation(location)
                    .then(self.GetAccessToken.bind(self, username, password))
                    .then(self.GetApiEndpoint)
                    .then(()=> {
                        return self.playerInfo
                    });
            });
    };

    self.GetAccessToken = function (user, pass) {
        self.DebugPrint('[i] Logging with user: ' + user);
        return Promise.resolve()
            .then(()=> {
                if (self.playerInfo.provider === 'ptc') {
                    return Logins.PokemonClub(user, pass, self)
                } else {
                    return Logins.GoogleAccount(user, pass, self)
                }
            })
            .then((token)=> {
                self.playerInfo.accessToken = token;
                self.DebugPrint('[i] Received PTC access token!');
                return token;
            });
    };


    self.GetApiEndpoint = function () {
        var req = [
            new RequestEnvelop.Requests(2),
            new RequestEnvelop.Requests(126),
            new RequestEnvelop.Requests(4),
            new RequestEnvelop.Requests(129),
            new RequestEnvelop.Requests(5)
        ];

        return apiRequest(api_url, self.playerInfo.accessToken, req)
            .then(function (response) {
                var api_endpoint = `https://${response.api_url}/rpc`;
                self.playerInfo.apiEndpoint = api_endpoint;
                self.DebugPrint('[i] Received API Endpoint: ' + api_endpoint);
                return api_endpoint;
            });
    };

    self.GetInventory = function (callback) {
        var req = new RequestEnvelop.Requests(4);

        self.GetProfile = function () {
            var req = new RequestEnvelop.Requests(2);
            return apiRequest(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req)
                .then(function (response) {
                    var profile = ResponseEnvelop.ProfilePayload.decode(response.payload[0]).profile;
                    if (profile.username) {
                        self.DebugPrint('[i] Logged in!');
                    }
                    return profile;
                });
        };

        // IN DEVELPOMENT, YES WE KNOW IS NOT WORKING ATM
        self.Heartbeat = function () {
            let {apiEndpoint, accessToken} = self.playerInfo;

            let nullbytes = new Buffer(21);
            nullbytes.fill(0);
            //let mquad = new RequestEnvelop.MessageQuad(0, nullbytes, ...GetCoords(self));

            // Generating walk data using s2 geometry
            var walk = getNeighbors(self.playerInfo.latitude, self.playerInfo.longitude).sort((a, b) => {
                return a.cmp(b);
            });
            var buffer = new ByteBuffer(21 * 10).LE();
            walk.forEach((elem) => {
                buffer.writeVarint64(s2.S2Utils.long_from_bignum(elem));
            });

            // Creating MessageQuad for Requests type=106
            buffer.flip();
            var walkData = new RequestEnvelop.MessageQuad({
                'f1': buffer.toBuffer(),
                'f2': nullbytes,
                'lat': self.playerInfo.latitude,
                'long': self.playerInfo.longitude
            });

            var req = [
                new RequestEnvelop.Requests(106, walkData.encode().toBuffer()),
                new RequestEnvelop.Requests(126),
                new RequestEnvelop.Requests(4, (new RequestEnvelop.Unknown3(Date.now().toString())).encode().toBuffer()),
                new RequestEnvelop.Requests(129),
                new RequestEnvelop.Requests(5, (new RequestEnvelop.Unknown3('05daf51635c82611d1aac95c0b051d3ec088a930')).encode().toBuffer())
            ];

            return apiRequest(apiEndpoint, accessToken, req)
                .then(function (response) {
                    console.log(response);
                    var heartbeat = ResponseEnvelop.HeartbeatPayload.decode(response.payload[0]);
                    console.log(heartbeat);
                    return heartbeat;
                })
        };

        self.GetLocation = function () {
            return new Promise(function (resolve, reject) {
                geocoder.reverseGeocode(...GetCoords(self), function (err, data) {
                    if (data.status === 'ZERO_RESULTS') {
                        return reject('Location not found');
                    }
                    resolve(data.results[0].formatted_address);
                });
            });
        };

        self.GetLocationCoords = function () {
            let {latitude, longitude, altitude} = self.playerInfo;
            return {latitude, longitude, altitude};
        };

        self.SetLocation = function (location) {
            return new Promise(function (resolve, reject) {
                if (location.type !== 'name' && location.type !== 'coords') {
                    return reject('Invalid location type');
                }

                if (location.type === 'name') {
                    if (!location.name) {
                        return reject('You should add a location name');
                    }
                    var locationName = location.name;
                    return geocoder.geocode(locationName, function (err, data) {
                        if (err || data.status === 'ZERO_RESULTS') {
                            return reject('location not found');
                        }

                        let {lat, lng} = data.results[0].geometry.location;

                        self.playerInfo.latitude = lat;
                        self.playerInfo.longitude = lng;
                        self.playerInfo.locationName = locationName;

                        return resolve(self.GetLocationCoords());
                    });
                } else if (location.type === 'coords') {
                    if (!location.coords) {
                        return reject('Coords object missing');
                    }

                    self.playerInfo.latitude = location.coords.latitude || self.playerInfo.latitude;
                    self.playerInfo.longitude = location.coords.longitude || self.playerInfo.longitude;
                    self.playerInfo.altitude = location.coords.altitude || self.playerInfo.altitude;

                    return geocoder.reverseGeocode(...GetCoords(self), function (err, data) {
                        if (data.status !== 'ZERO_RESULTS') {
                            self.playerInfo.locationName = data.results[0].formatted_address;
                        }

                        return resolve(self.GetLocationCoords());
                    });
                }
            });
        };
    }

}
module.exports = new Pokeio();
module.exports.Pokeio = Pokeio;

