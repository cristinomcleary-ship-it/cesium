# frozen_string_literal: true

# SketchUp's Ruby API must run on its UI thread. The short one-shot timer lets
# the requested .skp finish opening before the built-in GLB exporter starts.
UI.start_timer(0.1, false) do
  input_path = ENV['CESIUM_SKP_INPUT'].to_s
  output_path = ENV['CESIUM_SKP_OUTPUT'].to_s
  status_path = "#{output_path}.status"

  begin
    raise 'Missing CESIUM_SKP_INPUT' if input_path.empty?
    raise 'Missing CESIUM_SKP_OUTPUT' if output_path.empty?

    active_path = Sketchup.active_model.path.to_s
    unless File.expand_path(active_path).casecmp?(File.expand_path(input_path))
      opened = Sketchup.open_file(input_path)
      raise "SketchUp could not open #{input_path}" unless opened
    end

    exported = Sketchup.active_model.export(output_path, false)
    raise 'SketchUp GLB exporter returned failure' unless exported && File.file?(output_path)
    raise 'SketchUp GLB exporter produced an empty file' if File.size(output_path) < 20

    File.open(status_path, 'wb') { |file| file.write('ok') }
  rescue StandardError => error
    begin
      File.open(status_path, 'wb') do |file|
        file.write("#{error.class}: #{error.message}\n#{Array(error.backtrace).first(12).join("\n")}")
      end
    rescue StandardError
      # The caller will still detect the missing GLB/status file.
    end
  ensure
    Sketchup.quit
  end
end
