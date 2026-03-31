import os
import json
import sys
import xml.etree.ElementTree as ET
import re
import utilities as u 

from datetime import datetime, timedelta
from collections import defaultdict

from dotenv import load_dotenv
from pathlib import Path

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

# Load base .env file first (defaults)
load_dotenv(dotenv_path=base_env_path)

# Load local .env file second (overrides base, gitignored secrets)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

def parse_xml_file(xml_path):
    """Parse a single XML file and extract boundaries and marks."""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    
    # Extract timestamp - use CreationTimeDate
    timestamp = None
    creation_time = root.find('CreationTimeDate')
    if creation_time is not None and creation_time.text:
        timestamp = creation_time.text
    
    if not timestamp:
        u.log(api_token, "1_parseXml.py", "warning", "parsing XML", f"No timestamp found in {xml_path}")
        print(f"Warning: No timestamp found in {xml_path}", flush=True)
        return None, None, None
    
    # Extract boundaries - only from CourseLimit with name="Boundary"
    boundaries = []
    for course_limit in root.findall('CourseLimit'):
        # Only process CourseLimit with name="Boundary"
        if course_limit.attrib.get('name') == 'Boundary':
            for limit in course_limit.findall('Limit'):
                lat = limit.attrib.get('Lat')
                lon = limit.attrib.get('Lon')
                if lat and lon:
                    boundaries.append({
                        "LAT": lat,  # LAT contains latitude
                        "LON": lon   # LON contains longitude
                    })
    
    # Extract marks
    marks = []
    course = root.find('Course')
    if course is not None:
        for compound_mark in course.findall('CompoundMark'):
            compound_name = compound_mark.attrib.get('Name', 'Unknown')
            
            for mark in compound_mark.findall('Mark'):
                mark_name = mark.attrib.get('Name')
                target_lat = mark.attrib.get('TargetLat')
                target_lng = mark.attrib.get('TargetLng')
                
                if mark_name and target_lat and target_lng:
                    # Determine position based on name patterns
                    position = determine_position(mark_name, compound_name)
                    
                    marks.append({
                        "LAT": target_lat,
                        "LON": target_lng,
                        "NAME": mark_name,
                        "POSITION": position
                    })
    
    # Extract configurations
    configurations = None
    settings_elem = root.find('Settings')
    if settings_elem is not None:
        crew_elem = settings_elem.find('Crew')
        yacht_elem = settings_elem.find('Yacht')
        
        crew = crew_elem.attrib.get('Number', '') if crew_elem is not None else ''
        wing = yacht_elem.attrib.get('Wing', '') if yacht_elem is not None else ''
        jib = yacht_elem.attrib.get('Jib', '') if yacht_elem is not None else ''
        daggerboard = yacht_elem.attrib.get('Daggerboard', '') if yacht_elem is not None else ''
        rudder = yacht_elem.attrib.get('Rudder', '') if yacht_elem is not None else ''
        
        jib_name = None
        if wing == 'LAW' and jib == 'J1':
            jib_name = 'LA1'
        elif wing == 'APW' and jib == 'J1':
            jib_name = 'AP1'
        elif wing == 'APW' and jib == 'J2':
            jib_name = 'AP2'
        elif wing == 'HAW' and jib == 'J1':
            jib_name = 'HW1'
        elif wing == 'HAW' and jib == 'J2':
            jib_name = 'HW2'
        else:
            jib_name = 'NA'

        config_str = f"{wing}_{daggerboard}_{rudder}"

        config_name = None
        if config_str == 'APW_HSB2_LARW':
            config_name = 'M10'
        elif config_str == 'APW_HSB2_HSRW':
            config_name = 'M8'
        elif config_str == 'APW_LAB2_HSRW':
            config_name = 'M13'
        elif config_str == 'APW_LAB2_LARW':
            config_name = 'M12'
        elif config_str == 'LAW_LAB2_LARW':
            config_name = 'M11'
        elif config_str == 'APW_LAB_HSRW':
            config_name = 'M7'
        elif config_str == 'HAW_HSB_HSRW':
            config_name = 'M6'
        elif config_str == 'APW_HSB_HSRW':
            config_name = 'M5'
        elif config_str == 'HAW_HSB_LARW':
            config_name = 'M4'
        elif config_str == 'APW_HSB_LARW':
            config_name = 'M3'
        elif config_str == 'APW_LAB_LARW':
            config_name = 'M2'
        elif config_str == 'LAW_LAB_LARW':
            config_name = 'M1'
        elif config_str == 'APW_LAB2_HSRW2':
            config_name = 'M23'
        elif config_str == 'LAW2_LAB2_HSRW2':
            config_name = 'M22'
        elif config_str == 'LAW2_LAB2_LARW2':
            config_name = 'M21'
        elif config_str == 'APW_LAB2_LARW2':
            config_name = 'M16'
        elif config_str == 'APW_HSB2_LARW2':
            config_name = 'M17'
        elif config_str == 'APW_HSB2_HSRW2':
            config_name = 'M14'
        elif config_str == 'APW_LAB_HSRW2':
            config_name = 'M20'
        elif config_str == 'APW_LAB_LARW2':
            config_name = 'M19'
        elif config_str == 'LAW_LAB2_LARW2':
            config_name = 'M18'
        elif config_str == 'HAW_HSB2_HSRW2':
            config_name = 'M15'
        elif config_str == 'HAW_HSB2_HSRW':
            config_name = 'M9'
        else:
            config_name = 'NA'

        config_str = f"{config_name}-{jib_name}-{crew}"
        
        configurations = {
            "name": config_name,
            "wing": wing,
            "jib": jib_name,
            "daggerboard": daggerboard,
            "rudder": rudder,
            "crew": crew,
            "config": config_str
        }
    
    return timestamp, boundaries, marks, configurations


def determine_position(mark_name, compound_name):
    """Determine mark position based on naming patterns."""
    name_upper = mark_name.upper()
    compound_upper = compound_name.upper()
    
    # Check for start line indicators
    if 'SL' in name_upper or 'SL' in compound_upper or 'START' in compound_upper:
        return 'START'
    
    # Check for leeward gate
    if 'LG' in name_upper or 'LG' in compound_upper or 'LEEWARD' in compound_upper:
        return 'LEEWARD'
    
    # Check for windward gate
    if 'WG' in name_upper or 'WG' in compound_upper or 'WINDWARD' in compound_upper:
        return 'WINDWARD'
    
    # Check for finish line
    if 'FL' in name_upper or 'FL' in compound_upper or 'FINISH' in compound_upper:
        return 'FINISH'
    
    # Default to mark name or 'OTHER'
    return 'MARK'


def process_folder(folder_path):
    """Process all XML files in the folder."""
    boundaries_by_time = defaultdict(list)
    marks_by_time = defaultdict(list)
    configurations_by_time = {}
    
    # Get all XML files in the folder
    xml_files = [f for f in os.listdir(folder_path) if f.endswith('.xml')]
    
    if not xml_files:
        print(f"No XML files found in {folder_path}")
        return None, None, None
    
    print(f"Found {len(xml_files)} XML files to process...")
    
    for xml_file in xml_files:
        xml_path = os.path.join(folder_path, xml_file)
        print(f"Processing: {xml_file}")
        
        try:
            timestamp, boundaries, marks, configurations = parse_xml_file(xml_path)
            
            if timestamp:
                # Add boundaries to the timestamp group
                if boundaries:
                    boundaries_by_time[timestamp].extend(boundaries)
                
                # Add marks to the timestamp group
                if marks:
                    marks_by_time[timestamp].extend(marks)
                
                # Add configurations to the timestamp
                if configurations:
                    configurations_by_time[timestamp] = configurations
        
        except Exception as e:
            print(f"Error processing {xml_file}: {e}")
            continue
    
    # Format the output as requested
    boundaries_json = []
    for timestamp in sorted(boundaries_by_time.keys()):
        # Deduplicate boundaries by coordinates
        unique_boundaries = []
        seen = set()
        for boundary in boundaries_by_time[timestamp]:
            coord_tuple = (boundary['LAT'], boundary['LON'])
            if coord_tuple not in seen:
                seen.add(coord_tuple)
                unique_boundaries.append(boundary)
        
        boundaries_json.append({
            "DATETIME": timestamp,
            "BOUNDARIES": unique_boundaries
        })
    
    marks_json = []
    for timestamp in sorted(marks_by_time.keys()):
        # Deduplicate marks by coordinates
        unique_marks = []
        seen = set()
        for mark in marks_by_time[timestamp]:
            coord_tuple = (mark['LAT'], mark['LON'], mark['NAME'])
            if coord_tuple not in seen:
                seen.add(coord_tuple)
                unique_marks.append(mark)
        
        marks_json.append({
            "DATETIME": timestamp,
            "MARKS": unique_marks
        })
    
    # Format configurations with endtime calculation
    sorted_timestamps = sorted(configurations_by_time.keys())
    configurations_json = []
    
    for i, timestamp in enumerate(sorted_timestamps):
        # Parse timestamp
        start_dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        
        # Calculate endtime (10 minutes before next entry, or None for last entry)
        if i < len(sorted_timestamps) - 1:
            next_timestamp = sorted_timestamps[i + 1]
            next_dt = datetime.fromisoformat(next_timestamp.replace('Z', '+00:00'))
            end_dt = next_dt - timedelta(minutes=10)
            endtime = end_dt.isoformat()
        else:
            endtime = None  # Last entry doesn't have an endtime
        
        configurations_json.append({
            "starttime": timestamp,
            "endtime": endtime,
            "configuration": configurations_by_time[timestamp]
        })
    
    return boundaries_json, marks_json, configurations_json


def main():
    try:
        parameters_str = sys.argv[1]
        parameters_json = json.loads(parameters_str)

        #LOG
        u.log(api_token, "1_parseXml.py", "info", "parameters", parameters_str)

        class_name = parameters_json.get('class_name')
        project_id = parameters_json.get('project_id')
        date = parameters_json.get('date')
        file_path = parameters_json.get('file_path')

        # class_name = 'ac40'
        # project_id = 2
        # date = '20250817'
        # file_path = r'C:\MyApps\Hunico\Uploads\Data\Raw\2\ac40\20250817'
        
        # Check if file_path exists
        if not file_path:
            u.log(api_token, "1_parseXml.py", "error", "parsing XML", "file_path parameter is required")
            print("Error: file_path parameter is required", flush=True)
            return
            
        if not os.path.exists(file_path):
            u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Path not found: {file_path}")
            print(f"Path not found: {file_path}", flush=True)
            return
    
        # Determine if file_path is a file or directory
        if os.path.isfile(file_path):
            # If it's a single file, process just that file
            folder_path = os.path.dirname(file_path)
            u.log(api_token, "1_parseXml.py", "info", "parsing XML", f"Processing single file: {file_path}")
        else:
            # If it's a directory, process all XML files in it
            folder_path = file_path
            u.log(api_token, "1_parseXml.py", "info", "parsing XML", f"Processing folder: {folder_path}")
        
        # First pass: collect all XML files and their timestamps (optimized with regex)
        print("First pass: Collecting all files and timestamps...", flush=True)
        all_files_data = []
        processed_files = 0
        
        # Regex pattern to extract CreationTimeDate value (much faster than full XML parsing)
        timestamp_pattern = re.compile(r'<CreationTimeDate[^>]*>([^<]+)</CreationTimeDate>', re.IGNORECASE)
        
        def extract_timestamp_fast(xml_path):
            """Extract timestamp using regex (much faster than full XML parsing)."""
            try:
                with open(xml_path, 'r', encoding='utf-8', errors='ignore') as f:
                    # Read first 10KB (timestamp should be near the top of XML files)
                    content = f.read(10240)
                    match = timestamp_pattern.search(content)
                    if match:
                        return match.group(1).strip()
            except Exception:
                pass
            return None
        
        # If file_path is a single file, process just that file
        if os.path.isfile(file_path) and file_path.endswith('.xml'):
            timestamp = extract_timestamp_fast(file_path)
            if timestamp:
                all_files_data.append({
                    'path': file_path,
                    'timestamp': timestamp,
                    'filename': os.path.basename(file_path)
                })
                processed_files = 1
            else:
                u.log(api_token, "1_parseXml.py", "warning", "parsing XML", f"No timestamp found in {file_path}")
                print(f"Warning: No timestamp found in {file_path}", flush=True)
                processed_files = 1
        else:
            # Process all XML files in the folder
            total_files = 0
            
            # First, count total files for progress reporting
            for root_dir, subdirs, files in os.walk(folder_path):
                total_files += len([f for f in files if f.endswith('.xml')])
            
            print(f"Found {total_files} XML files to scan...", flush=True)
            
            for root_dir, subdirs, files in os.walk(folder_path):
                xml_files = [f for f in files if f.endswith('.xml')]
                
                if xml_files:
                    for xml_file in xml_files:
                        xml_path = os.path.join(root_dir, xml_file)
                        processed_files += 1
                        
                        # Progress reporting every 50 files
                        if processed_files % 50 == 0:
                            print(f"  Scanning files: {processed_files}/{total_files} ({processed_files*100//total_files}%)...", flush=True)
                        
                        timestamp = extract_timestamp_fast(xml_path)
                        if timestamp:
                            all_files_data.append({
                                'path': xml_path,
                                'timestamp': timestamp,
                                'filename': xml_file
                            })
                        else:
                            u.log(api_token, "1_parseXml.py", "warning", "parsing XML", f"No timestamp found in {xml_file}")
        
        # Sort files by timestamp
        all_files_data.sort(key=lambda x: x['timestamp'])
        
        print(f"Found {len(all_files_data)} XML files with valid timestamps (out of {processed_files} scanned)", flush=True)
        print()
        
        if not all_files_data:
            u.log(api_token, "1_parseXml.py", "error", "parsing XML", "No XML files found to process")
            print("No XML files found to process.", flush=True)
            return
        
        # Second pass: process files in sorted order
        total_files = len(all_files_data)
        print(f"Second pass: Processing {total_files} files in chronological order...", flush=True)
        all_boundaries = defaultdict(list)
        all_marks = defaultdict(list)
        all_configurations = {}
        
        for idx, file_data in enumerate(all_files_data, 1):
            xml_path = file_data['path']
            
            # Progress reporting every 10 files or for first/last file
            if idx == 1 or idx == total_files or idx % 10 == 0:
                print(f"Processing file {idx}/{total_files}: {file_data['filename']} at {file_data['timestamp']} ({idx*100//total_files}%)", flush=True)
            
            try:
                timestamp, boundaries, marks, configurations = parse_xml_file(xml_path)
                
                if timestamp:
                    # Add boundaries to the timestamp group
                    if boundaries:
                        all_boundaries[timestamp].extend(boundaries)
                    
                    # Add marks to the timestamp group
                    if marks:
                        all_marks[timestamp].extend(marks)
                    
                    # Add configurations to the timestamp
                    if configurations:
                        all_configurations[timestamp] = configurations
                        if idx == 1 or idx == total_files or idx % 10 == 0:
                            print(f"  -> Configurations found: {configurations['config']}", flush=True)
            
            except Exception as e:
                u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Error processing {file_data['filename']}: {e}")
                print(f"Error processing {file_data['filename']}: {e}", flush=True)
                continue
    
        # Format the final output
        boundaries_json = []
        boundary_id = 1
        for timestamp in sorted(all_boundaries.keys()):
            # Deduplicate boundaries by coordinates
            unique_boundaries = []
            seen = set()
            for boundary in all_boundaries[timestamp]:
                coord_tuple = (boundary['LAT'], boundary['LON'])
                if coord_tuple not in seen:
                    seen.add(coord_tuple)
                    unique_boundaries.append(boundary)
            
            boundaries_json.append({
                "ID": str(boundary_id),
                "DATETIME": timestamp,
                "BOUNDARIES": unique_boundaries
            })
            boundary_id += 1
        
        marks_json = []
        for timestamp in sorted(all_marks.keys()):
            # Deduplicate marks by coordinates and name
            unique_marks = []
            seen = set()
            for mark in all_marks[timestamp]:
                coord_tuple = (mark['LAT'], mark['LON'], mark['NAME'])
                if coord_tuple not in seen:
                    seen.add(coord_tuple)
                    unique_marks.append(mark)
            
            marks_json.append({
                "DATETIME": timestamp,
                "MARKS": unique_marks
            })
        
        # Format configurations - simple list with time and configuration
        configurations_json = []
        
        print(f"\nFormatting configurations with {len(all_configurations)} entries...", flush=True)
        
        for timestamp in sorted(all_configurations.keys()):
            configurations_json.append({
                "time": timestamp,
                "configuration": all_configurations[timestamp]
            })
            print(f"  Entry at: {timestamp}", flush=True)
        
        if not boundaries_json and not marks_json and not configurations_json:
            u.log(api_token, "1_parseXml.py", "error", "parsing XML", "No data to process")
            print("\nNo data to process.", flush=True)
            return

        # Post boundaries to API
        if boundaries_json:
            print("Posting boundaries to API...", flush=True)
            boundaries_json_str = json.dumps(boundaries_json, indent=2)
            jsondata = {
                "class_name": class_name,
                "project_id": project_id,
                "date": date,
                "object_name": "boundaries",
                "json": boundaries_json_str
            }
            try:
                res = u.post_api_data(api_token, ":8059/api/projects/object", jsondata)
                if res.get("success"):
                    print(f"Successfully posted boundaries ({len(boundaries_json)} entries)", flush=True)
                    u.log(api_token, "1_parseXml.py", "info", "parsing XML", f"Successfully posted boundaries: {len(boundaries_json)} entries")
                else:
                    print(f"Failed to post boundaries: {res.get('message', 'Unknown error')}", flush=True)
                    u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Failed to post boundaries: {res.get('message', 'Unknown error')}")
            except Exception as e:
                print(f"Error posting boundaries: {e}", flush=True)
                u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Error posting boundaries: {e}")
        
        # Post marks to API
        if marks_json:
            print("Posting marks to API...", flush=True)
            marks_json_str = json.dumps(marks_json, indent=2)
            jsondata = {
                "class_name": class_name,
                "project_id": project_id,
                "date": date,
                "object_name": "marks",
                "json": marks_json_str
            }
            try:
                res = u.post_api_data(api_token, ":8059/api/projects/object", jsondata)
                if res.get("success"):
                    print(f"Successfully posted marks ({len(marks_json)} entries)", flush=True)
                    u.log(api_token, "1_parseXml.py", "info", "parsing XML", f"Successfully posted marks: {len(marks_json)} entries")
                else:
                    print(f"Failed to post marks: {res.get('message', 'Unknown error')}", flush=True)
                    u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Failed to post marks: {res.get('message', 'Unknown error')}")
            except Exception as e:
                print(f"Error posting marks: {e}", flush=True)
                u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Error posting marks: {e}")
        
        # Post configurations to API
        if configurations_json:
            print("Posting configurations to API...", flush=True)
            configurations_json_str = json.dumps(configurations_json, indent=2)
            jsondata = {
                "class_name": class_name,
                "project_id": project_id,
                "date": date,
                "object_name": "configurations",
                "json": configurations_json_str
            }
            try:
                res = u.post_api_data(api_token, ":8059/api/projects/object", jsondata)
                if res.get("success"):
                    print(f"Successfully posted configurations ({len(configurations_json)} entries)", flush=True)
                    u.log(api_token, "1_parseXml.py", "info", "parsing XML", f"Successfully posted configurations: {len(configurations_json)} entries")
                else:
                    print(f"Failed to post configurations: {res.get('message', 'Unknown error')}", flush=True)
                    u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Failed to post configurations: {res.get('message', 'Unknown error')}")
            except Exception as e:
                print(f"Error posting configurations: {e}", flush=True)
                u.log(api_token, "1_parseXml.py", "error", "parsing XML", f"Error posting configurations: {e}")
        
        print()
        u.log(api_token, "1_parseXml.py", "info", "parsing XML", "Script completed successfully")
        print("Script completed successfully!", flush=True)
        
        # Update dataset date_modified after successful XML parsing
        # Note: This script processes multiple sources, so we update for each source
        # The date_modified will be updated when normalization/processing scripts run
        # If needed, we could iterate through sources here, but it's better to update
        # after the actual data processing that follows XML parsing
        
    except Exception as error:
        print("Error:", str(error), flush=True)
        u.log(api_token, "1_parseXml.py", "error", "parsing XML", "script exception error:"+str(error))


if __name__ == "__main__":
    main()