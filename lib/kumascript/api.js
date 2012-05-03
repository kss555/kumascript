// ## KumaScript template API
//
// This module provides the API exposed to templates for utilities and wiki
// query functionality.
//
// A lot of this code started from implementing APIs that are vaguely
// compatible with [things provided by MindTouch in DekiScript][dekiref].
//
// This shouldn't end up being a full reimplementation of the DekiScript API,
// though. We just need a subset of the API actually used by legacy MDN
// templates, and we can diverge from there.
//
// [dekiref]: http://developer.mindtouch.com/en/docs/DekiScript/Reference
//
// TODO: Maybe split this module up into namespace-specific modules for easier
// editing?

/*jshint node: true, expr: false, boss: true */

// ### Prerequisites
var util = require('util'),
    vm = require("vm"),
    _ = require('underscore'),
    async = require('async'),

    // This also injects `Fiber` and `yield`
    fibers = require('fibers'),
    Future = require('fibers/future'),
    wait = Future.wait,
    request = require('request'),
    Memcached = require('memcached'),

    ks_macros = require(__dirname + '/macros'),
    ks_utils = require(__dirname + '/utils');

// ### BaseAPI
//
// Base container for a namespaced sub-API
var BaseAPI = ks_utils.Class({
    
    initialize: function (options) {
        this.parent = this.options.parent;

        // HACK: Create mixed case name aliases for all functions.
        var fn_names = _.functions(this);
        for (var i=0, name; name=fn_names[i]; i++) {
            setCaseVariantAliases(this, name, this[name]);
        }
    },

    // #### setVars(object)
    // Copy the properties from the given object onto this API.
    setVars: function (vars) {
        var $this = this;
        _.each(vars, function (v,n) {
            setCaseVariantAliases($this, n, v);
        });
    }

});

// ### KumaAPI
//
// Grab bag of Kuma-specific API methods and utilities. 
//
// This has to live here, rather than in an auto-required template. Because,
// it grants access to some node.js modules that are otherwise inaccessible to
// templates which are not allowed to use require() from node.js
var KumaAPI = ks_utils.Class(BaseAPI, {

    // #### debug
    // Expose util.debug from node.js
    debug: util.debug,
    
    // #### url
    // Expose url from node.js to templates
    url: require('url'),

    // #### htmlEscape(string)
    // Escape the given string for HTML inclusion.
    htmlEscape: function (s) {                                       
        return (''+s).replace(/&/g,'&amp;').
                 replace(/>/g,'&gt;').
                 replace(/</g,'&lt;').
                 replace(/"/g,'&quot;');
    }

});

// ### PageAPI
// <http://developer.mindtouch.com/en/docs/DekiScript/Reference/Wiki_Functions_and_Variables/Page>
var PageAPI = ks_utils.Class(BaseAPI, {
    
    initialize: function (options) {
        BaseAPI.prototype.initialize.call(this, options);
        var $this = this;

        // TODO: Need to thread through page details from Server to APIContext to here.
        this.setVars({
            uri: 'http://example.com/en/HTML/FakePage',
            language: 'en'
        });
    }

});

// ### FakeMemcached
//
// A minimal stub replacement for Memcached, in case it's missing from the
// config. That way, kumascript can be used without memcache, even if that's
// not recommended.
var FakeMemcached = ks_utils.Class({
    initialize: function (options) {
        this._cache = {};
    },
    set: function (key, value, tm_out, next) {
        this._cache[key] = value;
        next(null, true);
    },
    get: function (key, next) {
        next(null, this._cache[key]);
    }
});

// ### APIContext
//
// Instances of this class manage instances of sub-APIs, supplying them with
// contextual info about the page in which macros are evaluated. Template
// scripts, in turn, use instances of this class to access sub-APIs.
var APIContext = ks_utils.Class({

    default_options: {
        server_options: {},
        env: {},
        source: '',
        apis: {
            kuma: KumaAPI
        }
    },
    
    // #### initialize
    //
    // Initialize the API context.
    initialize: function (options) {
        _.each(this.options.apis, _.bind(this.installAPI, this));

        // Make the env vars more easily used, if given
        if (this.options && this.options.env) {
            this.env = this.options.env;
        }

        // Create a memcache instance, if necessary
        if (this.options.server_options.memcache) {
            var mo = this.options.server_options.memcache;
            this.memcached = new Memcached(mo.server, mo.options || {});
        } else {
            // If the configuration is missing, use the fake stub cache
            this.memcached = new FakeMemcached();
        }

        // Create a new cache for required templates.
        this._require_cache = {};
    },

    // #### BaseAPI
    // Grant access to the BaseAPI class
    BaseAPI: BaseAPI,

    // #### Future
    // Allow access to node-fiber Future from templates.
    Future: Future,

    // #### request
    //
    // Allow access to mikeal/request in templates and libraries, so they can
    // easily make HTTP requests. 
    //
    // TODO: Very permissive. Should there be more restrictions on net access?
    request: request,
    
    // Install a new instance of the given API class, with the given name.
    installAPI: function (cls, name) {
        setCaseVariantAliases(this, name, new cls({parent: this}));
    },

    // #### buildAPI(prototype)
    //
    // Utility method for building a new BaseAPI-based API, useful for building
    // APIs in templates. Handy in conjuction with autorequire. See tests for
    // details.
    buildAPI: function (proto) {
        var cls = ks_utils.Class(BaseAPI, proto);
        return new cls({ parent: this });
    },

    // #### performAutoRequire
    //
    // Auto-require some templates and install the exports as APIs. This is
    // kind of a hack, but I wanted to use the require method.
    performAutoRequire: function (next) {
        var $this = this,
            server_options = $this.options.server_options;

        // Skip this whole thing, if there are no autorequires
        if (!server_options.autorequire) { return next(null); }

        // Run this in a parallel forEach, to block less on network.
        async.forEach(
            _.keys(server_options.autorequire),
            function (install_name, fe_next) {
                // require() expects to run inside a Fiber
                Fiber(function () {
                    var tmpl_name = server_options.autorequire[install_name],
                        exports = $this.require(tmpl_name);
                    setCaseVariantAliases($this, install_name, exports);
                    fe_next();
                }).run();
            },
            next
        );
    },

    // #### setArguments
    // Given a list of arguments, make them available to a template as $0..$n
    // variables.
    setArguments: function (args) {
        var $this = this;
        // Both arguments and $$ are aliases for the list of macro args.
        $this['arguments'] = $this.$$ = args || [];
        // HACK: Clear out, yet ensure $0..$99 exist
        for (var i=0; i<99; i++) {
            $this['$'+i] = '';
        }
        // Assign each element of args to $0..$n
        _.each(args, function (v, i) {
            $this['$'+i] = v;
        });
        return this;
    },

    // #### cacheFn
    // Cache the results of a function
    cacheFn: function (key, tm_out, to_cache) {
        var result = null,
            f = new Future(),
            mc = this.memcached;
        mc.get(key, function (err, c_result) {
            if (c_result) {
                result = c_result; f['return']();
            } else {
                to_cache(function (val) {
                    mc.set(key, val, tm_out, function (err, c_result) {
                        result = val; f['return']();
                    })
                })
            }
        });
        f.wait();
        return result;
    },

    // #### template(name, arguments)
    //
    // Attempt to load and execute a template with the given name and
    // arguments. The output, if any, is returned. Errors, if any, are pushed
    // up to the macro processor
    template: function (name, args) {

        // TODO: Implement caching here by building a key out of hashed args?
        // Probably not a big win, since the result of the template calling
        // this template will itself be cached during macro evaluation.

        // Try loading the template, using a node-fibers Future to avoid
        // imposing async on templates.
        var $this = this,
            future = new Future(),
            loader = $this.loader,
            errors = $this.errors,
            output = '';

        try {
            // Try loading the template...
            loader.get(name, function (err, tmpl) {
                if (!err) {
                    // Try executing the template...
                    clone_ctx = _.clone($this).setArguments(args);
                    tmpl.execute(args, clone_ctx, function (err, result) {
                        if (err) { 
                            // There was an error executing the template. :(
                            var tok = {type: 'none', name: name};
                            errors.push(new ks_macros.TemplateExecutionError(
                                        {token: tok, error: err}));
                        }
                        output = result;
                        future['return']();
                    });
                } else {
                    // There was an error loading the template. :(
                    errors.push(new ks_macros.TemplateLoadingError(
                                {name: name, error: err}));
                    future['return']();
                }
            });
        } catch (e) {
            // There was an error executing the template. :(
            errors.push(new ks_macros.TemplateLoadingError(
                        {name: name, error: e}));
            future['return']();
        }

        // Wait here for the async magic to complete.
        future.wait();

        return output;
    },

    // #### require(path)
    //
    // Attempts to load and execute a template which, as a side effect, can
    // populate an exports object in quasi-CommonJS style. The template output
    // is ignored.
    require: function (name) {

        // Use an internal cache, so that repeated require() calls reuse the
        // previously loaded results.
        if (!(name in this._require_cache)) {
            clone_ctx = _.clone(this);

            // Let's pretend we're following CommonJS module conventions
            clone_ctx.module = { exports: {} };
            clone_ctx.exports = clone_ctx.module.exports;

            // clone_ctx is just like calling a template, only we ignore the output
            // and return the side effect of populating exports.
            var output = clone_ctx.template(name, []);
            this._require_cache[name] = clone_ctx.module.exports;
        }

        return this._require_cache[name];
    }

});

// ### setCaseVariantAliases
//
// THIS IS A BIG FAT HAIRY HACK. And, it has a long name, so no one forgets it.
//
// Set a property on an object with aliases of various mixed cases. For example:
//
//     page.location, Page.location, Page.Location, page.Location
//
// There's no such thing as case-insensitive object keys in JS, but
// apparently there are in DekiScript. This hack just covers the most
// common slack in known MDN templates.
//
// Harmony proxies might be a solution, in that an attribute access proxy could
// intercept and squash case. But, it requires a compiled C++ component and
// seems like overkill.
//
// <https://github.com/samshull/node-proxy>
//
// Running with the V8 option --harmony_proxies seems like a lead, especially
// when combined with this (thanks, David Bruant):
//
// <https://github.com/Benvie/Direct-Proxies-Shim-Shim-for-Node-and-Chrome>
//
// But, `--harmony_proxies` is off by default, which makes me hesitant to rely
// on it for a production service.
//
function setCaseVariantAliases($this, name, val) {

    // As-is from the source.
    $this[name] = val;
    
    // lowercase
    $this[name.toLowerCase()] = val;

    // Capitalized
    var uc_name = name.charAt(0).toUpperCase() + name.slice(1);
    $this[uc_name] = val;

}

// ### Exported public API
module.exports = {
    APIContext: APIContext,
    BaseAPI: BaseAPI,
    KumaAPI: KumaAPI
};