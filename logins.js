'use strict';

const login_url = 'https://sso.pokemon.com/sso/login?service=https%3A%2F%2Fsso.pokemon.com%2Fsso%2Foauth2.0%2FcallbackAuthorize',
    login_oauth = 'https://sso.pokemon.com/sso/oauth2.0/accessToken',

// Google Parts
    android_id = '9774d56d682e549c',
    oauth_service = 'audience:server:client_id:848232511240-7so421jotr2609rmqakceuu1luuq0ptb.apps.googleusercontent.com',
    app = 'com.nianticlabs.pokemongo',
    client_sig = '321187995bc7cdc2b5fc91b11a96e2baa8602c62';

module.exports = {
    PokemonClub: function (user, pass, self, callback) {
        var options = {
            url: login_url,
            headers: {
                'User-Agent': 'niantic'
            },
            json: true
        };

        return self.request.get(options)
            .then((data)=> {
                return self.request.post(options = {
                    url: login_url,
                    form: {
                        'lt': data.lt,
                        'execution': data.execution,
                        '_eventId': 'submit',
                        'username': user,
                        'password': pass
                    },
                    headers: {
                        'User-Agent': 'niantic'
                    },
                    simple: false,
                    resolveWithFullResponse: true
                });
            })
            .then((response)=> {
                if (response.statusCode === 302) {
                    options.url = response.headers.location;
                    return self.request.post(options);
                }
            })
            .then((response)=> {
                console.log(response.body);
                var parsedBody = JSON.parse(response.body);
                if (parsedBody.errors && parsedBody.errors.length !== 0) {
                    throw 'Error logging in: ' + parsedBody.errors[0];
                }

                return self.request.post({
                    url: login_oauth,
                    form: {
                        'client_id': 'mobile-app_pokemon-go',
                        'redirect_uri': 'https://www.nianticlabs.com/pokemongo/error',
                        'client_secret': 'w8ScCUXJQc6kXKw8FiOhd8Fixzht18Dq3PEVkUCP5ZPxtgyWsbTvWHFLm2wNY0JR',
                        'grant_type': 'refresh_token',
                        'code': response.headers['location'].split('ticket=')[1]
                    },
                    headers: {
                        'User-Agent': 'niantic'
                    }
                });
            })
            .then((response, body)=> {
                var token = body.split('token=')[1].split('&')[0];

                if (!token) {
                    throw 'Login failed';
                }

                self.DebugPrint('[i] Session token: ' + token);
                return token;
            });
    },
    GoogleAccount: function (user, pass, self) {
        return new Promise((resolve, reject) => {
            return self.google.login(user, pass, android_id, function (err, data) {
                if (err) {
                    return reject(err.message);
                }

                return self.google.oauth(user, data.masterToken, data.androidId, oauth_service, app, client_sig, function (err, data) {
                    return err ? reject(err.message) : resolve(data.Auth);
                });
            });
        });

    }
};
