'use strict';

module.exports = function(grunt) {

  // Nodejs libs.
  var fs = require('fs');
  var path = require('path');
  var livereload;

  // ==========================================================================
  // TASKS
  // ==========================================================================

  // Keep track of last modified times of files, in case files are reported to
  // have changed incorrectly. Also used to detect chnages during task runs.
  var mtimes = {};

  grunt.registerTask('watch', 'Run predefined tasks whenever watched files change.', function(target) {
    this.requiresConfig('watch');
    // Build an array of files/tasks objects.
    var watch = grunt.config('watch');
    var targets = target ? [target] : Object.keys(watch).filter(function(key) {
      return typeof watch[key] !== 'string' && !Array.isArray(watch[key]);
    });

    //-- Nasty live reloader hacks
    var liveReloaders = {},
        defaultLiveReloader,
        taskLRConfig = grunt.config([self.name, 'options', 'livereload']);
    if(taskLRConfig) {
      defaultLiveReloader = require('./lib/livereload')(grunt)(taskLRConfig);
    }
    var createLiveReloaderFor = function(target) {
      // If a default livereload server for all targets
      // Use task level unless target level overrides
      var targetLRConfig = grunt.config([self.name, target, 'options', 'livereload']);
      if (targetLRConfig || taskLRConfig) {
        liveReloaders[target] = targetLRConfig ? require('./lib/livereload')(grunt)(targetLRConfig) : defaultLiveReloader;
      }
    };
    //-- / Nasty livereloader hacks

    targets = targets.map(function(target) {
      // Fail if any required config properties have been omitted.
      target = ['watch', target];
      this.requiresConfig(target.concat('files'), target.concat('tasks'));
      createLiveReloaderFor(target)
      return grunt.config(target);
    }, this);

    // Allow "basic" non-target format.
    if (typeof watch.files === 'string' || Array.isArray(watch.files)) {
      targets.push({files: watch.files, tasks: watch.tasks});
    }

    grunt.log.write('Waiting...');

    // This task is asynchronous.
    var taskDone = this.async();
    // Get a list of files to be watched.
    var patterns = grunt.util._.pluck(targets, 'files');
    var getFiles = function() { return grunt.file.expand({filter: 'isFile', cwd: process.cwd()}, patterns); }
    // This task's name + optional args, in string format.
    var nameArgs = this.nameArgs;
    // An ID by which the setInterval can be canceled.
    var intervalId;
    // Files that are being watched.
    var watchedFiles = {};
    // File changes to be logged.
    var changedFiles = {};

    // List of changed / deleted file paths.
    grunt.file.watchFiles = {changed: [], deleted: []};

    // Define an alternate fail "warn" behavior.
    grunt.fail.warnAlternate = function() {
      grunt.task.clearQueue({untilMarker: true}).run(nameArgs);
    };

    // Cleanup when files have changed. This is debounced to handle situations
    // where editors save multiple files "simultaneously" and should wait until
    // all the files are saved.
    var done = grunt.util._.debounce(function() {
      // Clear the files-added setInterval.
      clearInterval(intervalId);
      // Ok!
      grunt.log.ok();
      var fileArray = Object.keys(changedFiles);
      fileArray.forEach(function(filepath) {
        var status = changedFiles[filepath];
        // Log which file has changed, and how.
        grunt.log.ok('File "' + filepath + '" ' + status + '.');
        // Add filepath to grunt.file.watchFiles for grunt.file.expand* methods.
        grunt.file.watchFiles[status === 'deleted' ? 'deleted' : 'changed'].push(filepath);
        // Clear the modified file's cached require data.
        clearRequireCache(filepath);
      });
      // Unwatch all watched files.
      Object.keys(watchedFiles).forEach(unWatchFile);
      // For each specified target, test to see if any files matching that
      // target's file patterns were modified.
      targets.forEach(function(target) {
        // What files in fileArray match the target.files pattern(s)?
        var files = grunt.file.match(target.files, fileArray);
        // Enqueue specified tasks if at least one matching file was found.
        if (files.length > 0 && target.tasks) {
          grunt.task.run(target.tasks).mark();
        }
      });
      // Enqueue the watch task, so that it loops.
      grunt.task.run(nameArgs);
      // Continue task queue.
      // Trigger livereload if necessary
      if (livereload) {
        livereload.trigger(fileArray);
      }

      taskDone();
    }, 250);

    // Handle file changes.
    function fileChanged(status, filepath) {
      // If file was deleted and then re-added, consider it changed.
      if (changedFiles[filepath] === 'deleted' && status === 'added') {
        status = 'changed';
      }
      // Keep track of changed status for later.
      changedFiles[filepath] = status;
      // Execute debounced done function.
      done();
    }

    // Watch a file.
    function watchFile(filepath) {
      if (!watchedFiles[filepath]) {
        // Watch this file for changes. This probably won't scale to hundreds of
        // files.. but I bet someone will try it!
        watchedFiles[filepath] = fs.watch(filepath, function(event) {
          var mtime;
          // Has the file been deleted?
          var deleted = !grunt.file.exists(filepath);
          if (deleted) {
            // If file was deleted, stop watching file.
            unWatchFile(filepath);
            // Remove from mtimes.
            delete mtimes[filepath];
          } else {
            // Get last modified time of file.
            mtime = +fs.statSync(filepath).mtime;
            // If same as stored mtime, the file hasn't changed.
            if (mtime === mtimes[filepath]) { return; }
            // Otherwise it has, store mtime for later use.
            mtimes[filepath] = mtime;
          }
          // Call "change" for this file, setting status appropriately (rename ->
          // renamed, change -> changed).
          fileChanged(deleted ? 'deleted' : event + 'd', filepath);
        });
      }
    }

    // Unwatch a file.
    function unWatchFile(filepath) {
      if (watchedFiles[filepath]) {
        // Close watcher.
        watchedFiles[filepath].close();
        // Remove from watched files.
        delete watchedFiles[filepath];
      }
    }

    // Watch all currently existing files for changes.
    getFiles().forEach(watchFile);

    // Watch for files to be added.
    intervalId = setInterval(function() {
      // Files that have been added since last interval execution.
      var added = grunt.util._.difference(getFiles(), Object.keys(watchedFiles));
      added.forEach(function(filepath) {
        // Get last modified time of file - update this first so it is as early as poss.
        // this means addtitional changes can't be accidentlayy eaten by the mtime filter.
        var mtime = +fs.statSync(filepath).mtime;
        mtimes[filepath] = mtime
        // This file has been added.
        fileChanged('added', filepath);
        // Watch this file.
        watchFile(filepath);
      });
    }, 200);

    //Walk the watchedList and see if they differ from our recorded mtimes
    Object.keys(watchedFiles).forEach(function(filepath) {
      var mtime = +fs.statSync(filepath).mtime;
      if (filepath in mtimes) {
        if (mtime !=  mtimes[filepath]) {
          mtimes[filepath] = mtime;
          fileChanged('changed', filepath);
        }
      } else {
        mtime = +fs.statSync(filepath).mtime;
        mtimes[filepath] = mtime;
        fileChanged('added', filepath);
      }
    });


  });
  // Clear the require cache for all passed filepaths.
  var clearRequireCache = function() {
    // If a non-string argument is passed, it's an array of filepaths, otherwise
    // each filepath is passed individually.
    var filepaths = typeof arguments[0] !== 'string' ? arguments[0] : grunt.util.toArray(arguments);
    // For each filepath, clear the require cache, if necessary.
    filepaths.forEach(function(filepath) {
      var abspath = path.resolve(filepath);
      if (require.cache[abspath]) {
        grunt.verbose.write('Clearing require cache for "' + filepath + '" file...').ok();
        delete require.cache[abspath];
      }
    });
  };

};
